import { fileURLToPath } from "node:url";
const EXTENSION = fileURLToPath(new URL("../pi/acp.ts", import.meta.url));
// The longest path a Unix socket can have (macOS's; Linux allows 107).
const SOCKET_MAX = 103;
// The revision a session's creator asked its workspace to start at (_meta.pi.revision, a jj revset).
const revisionOf = (given) => {
    const pi = given?.pi;
    return pi && typeof pi === "object" && "revision" in pi && typeof pi.revision === "string" ? pi.revision : undefined;
};
const quote = (s) => `'${s.replaceAll("'", `'\\''`)}'`;
export function piAgent(opts) {
    const shell = opts.shell ?? ((script) => ["sh", "-c", script]);
    // pi's regular TUI (the terminal's own scrollback), unless its command line picks one: a client attaches to pi's
    // terminal after pi set it up, and dtach replays nothing, so a fullscreen pi's alternate screen and modes never reach
    // it (its frames pile up in the client's scrollback, its mouse scrolls the client). A regular pi draws everything
    // again, at the new width, when its size changes.
    const pi = opts.pi ?? ["pi"];
    const mode = pi.some((a) => a === "--tui-mode" || a.startsWith("--tui-mode=")) ? [] : ["--tui-mode", "regular"];
    const command = [...pi, ...mode, ...[opts.extension ?? EXTENSION, ...(opts.extensions ?? [])].flatMap((e) => ["-e", e])].map(quote).join(" ");
    // A session's files there, quoted for its scripts (its workspace's for the directory it was given, CWD).
    const files = (session, cwd = "") => {
        const run = `${opts.dir}/run/${session}`;
        const workspaces = (opts.workspaces ?? `${opts.dir}/workspaces`).replaceAll("{project}", cwd);
        return { run: quote(`${opts.dir}/run`), workspaces: quote(workspaces), tty: quote(`${run}.tty`), acp: quote(`${run}.sock`), pid: quote(`${run}.pid`), err: quote(`${run}.err`), sessions: quote(`${run}.sessions`), workspace: quote(`${workspaces}/${session}`) };
    };
    // Whether the session's pi is running: its terminal's socket takes a connection (one left by a crash or a reboot
    // doesn't, and a pid may have been reused since).
    const running = (tty) => `dtach -p ${tty} </dev/null 2>/dev/null`;
    return {
        id: opts.id ?? "pi",
        displayName: opts.displayName ?? "pi",
        description: "pi in its own terminal",
        follow: true,
        connect(session, cwd, given) {
            const socket = `${opts.dir}/run/${session}.sock`;
            if (Buffer.byteLength(socket) > SOCKET_MAX)
                throw new Error(`${socket} is too long for a Unix socket: give pi a shorter dir than ${opts.dir}`);
            const f = files(session, cwd);
            const revision = revisionOf(given);
            return shell([
                "set -e",
                `mkdir -p ${f.run}`,
                `cd ${quote(cwd)}`,
                "if [ -d .jj/repo ]; then",
                `  mkdir -p ${f.workspaces}`,
                `  if [ ! -d ${f.workspace} ]; then`,
                ...(revision === undefined
                    ? [`    jj workspace add --quiet --name ${quote(session)} ${f.workspace}`]
                    : [
                        // A workspace working on that revision moves off it first (onto a new change of its own on top), or
                        // each of its snapshots would rewrite the revision under this one.
                        `    for w in $(jj log --no-graph -r ${quote(revision)} -T working_copies); do (cd "$(jj workspace root --name "\${w%@}")" && jj new --quiet); done`,
                        `    jj workspace add --quiet --name ${quote(session)} -r ${quote(revision)} ${f.workspace}`,
                    ]),
                "  fi",
                `  cd ${f.workspace}`,
                "fi",
                `if ! ${running(f.tty)}; then`,
                `  rm -f ${f.acp} ${f.tty} ${f.err}`,
                // On the pi session it was on last (its bridge keeps each one it moved to: /new, /resume, a fork), else its own.
                `  PI_ACP_SOCKET=${f.acp} PI_SESSIONS_FILE=${f.sessions} dtach -n ${f.tty} -z sh -c ${quote(`echo $$ > ${f.pid}; last=$(tail -n 1 ${f.sessions} 2>/dev/null); exec ${command} --session-id "\${last:-${session}}" 2>${f.err}`)}`,
                "fi",
                // Until its socket is there; a pi that exited (its terminal gone) says why at once.
                `i=0; until [ -S ${f.acp} ]; do`,
                `  ${running(f.tty)} || { tail -n 3 ${f.err} >&2; exit 1; }`,
                `  i=$((i+1)); [ $i -lt 600 ] || { echo "pi didn't start" >&2; exit 1; }; sleep 0.05`,
                "done",
                `exec nc -U ${f.acp}`,
            ].join("\n"));
        },
        // Its terminal, once its pi is up (its ACP socket there): a client that attaches as pi starts misses pi's first
        // drawing, and pi draws again only when its size changes.
        meta: (session) => {
            const f = files(session);
            return { pi: { attach: shell(`i=0; until [ -S ${f.acp} ] || [ $i -ge 600 ]; do i=$((i+1)); sleep 0.05; done; exec dtach -a ${f.tty} -r winch -z`) } };
        },
        stop(session) {
            const f = files(session);
            return shell(`${running(f.tty)} && kill "$(cat ${f.pid})"; true`);
        },
        dispose(session, cwd) {
            const f = files(session, cwd);
            return shell([
                `${running(f.tty)} && kill "$(cat ${f.pid})"`,
                `rm -f ${f.pid} ${f.acp} ${f.tty} ${f.err} ${f.sessions}`,
                `if [ -d ${f.workspace} ]; then (cd ${quote(cwd)} && jj workspace forget ${quote(session)}) 2>/dev/null; rm -rf ${f.workspace}; fi`,
                "true",
            ].join("\n"));
        },
    };
}
