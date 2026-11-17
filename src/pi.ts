import { fileURLToPath } from "node:url";
import type { AcpProvider } from "./acp-chat.ts";

// pi's own TUI as an ACP agent's session (pi/acp.ts): each session one pi, kept running under dtach in its place
// (here, or in a box `shell` reaches), in a jj workspace of its own when its working directory is a jj repo's main
// checkout (a workspace already, it works there as it is), started at the revision its creator's _meta.pi.revision
// names, when it names one; pi says where it works, so the session's working directory is that. Archived, its pi
// stops (`stop`), its session file and workspace kept for it to carry on from. The host's connection is the same script every time: it starts the session's pi if it isn't running (`--session-id` the
// session's, so a restarted pi carries on from its session file), waits for its socket, and becomes the bridge to it.
// Anyone can open the same pi's terminal with the session's _meta.pi.attach, and what's typed there shows in the chat.

export interface PiOptions {
  id?: string;
  displayName?: string;
  // Where the sessions' sockets go, in the place `shell` runs, and their workspaces (`workspaces`: a folder, with
  // `{project}` for the directory a session was given, "{project}__workspaces" say; `<dir>/workspaces` by default).
  dir: string;
  workspaces?: string;
  // pi's command line there, the extension's path there, and more extensions for every session's pi.
  pi?: string[];
  extension?: string;
  extensions?: string[];
  // A script's command line in the place: `sh -c` here by default; ssh into a box, say.
  shell?: (script: string) => string[];
}

const EXTENSION = fileURLToPath(new URL("../pi/acp.ts", import.meta.url));
// The longest path a Unix socket can have (macOS's; Linux allows 107).
const SOCKET_MAX = 103;
// The revision a session's creator asked its workspace to start at (_meta.pi.revision, a jj revset).
const revisionOf = (given?: Record<string, unknown>) => {
  const pi = given?.pi;
  return pi && typeof pi === "object" && "revision" in pi && typeof pi.revision === "string" ? pi.revision : undefined;
};
const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

export function piAgent(opts: PiOptions): AcpProvider {
  const shell = opts.shell ?? ((script: string) => ["sh", "-c", script]);
  const command = [...(opts.pi ?? ["pi"]), ...[opts.extension ?? EXTENSION, ...(opts.extensions ?? [])].flatMap((e) => ["-e", e])].map(quote).join(" ");
  // A session's files there, quoted for its scripts (its workspace's for the directory it was given, CWD).
  const files = (session: string, cwd = "") => {
    const run = `${opts.dir}/run/${session}`;
    const workspaces = (opts.workspaces ?? `${opts.dir}/workspaces`).replaceAll("{project}", cwd);
    return { run: quote(`${opts.dir}/run`), workspaces: quote(workspaces), tty: quote(`${run}.tty`), acp: quote(`${run}.sock`), pid: quote(`${run}.pid`), workspace: quote(`${workspaces}/${session}`) };
  };
  // Whether the session's pi is running: its terminal's socket takes a connection (one left by a crash or a reboot
  // doesn't, and a pid may have been reused since).
  const running = (tty: string) => `dtach -p ${tty} </dev/null 2>/dev/null`;
  return {
    id: opts.id ?? "pi",
    displayName: opts.displayName ?? "pi",
    description: "pi in its own terminal",
    follow: true,
    connect(session, cwd, given) {
      const socket = `${opts.dir}/run/${session}.sock`;
      if (Buffer.byteLength(socket) > SOCKET_MAX) throw new Error(`${socket} is too long for a Unix socket: give pi a shorter dir than ${opts.dir}`);
      const f = files(session, cwd);
      const revision = revisionOf(given);
      return shell(
        [
          "set -e",
          `mkdir -p ${f.run} ${f.workspaces}`,
          `cd ${quote(cwd)}`,
          "if [ -d .jj/repo ]; then",
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
          `  rm -f ${f.acp} ${f.tty}`,
          `  PI_ACP_SOCKET=${f.acp} dtach -n ${f.tty} -z sh -c ${quote(`echo $$ > ${f.pid}; exec ${command} --session-id ${quote(session)}`)}`,
          "fi",
          `i=0; until [ -S ${f.acp} ]; do i=$((i+1)); [ $i -lt 600 ] || { echo "pi didn't start" >&2; exit 1; }; sleep 0.05; done`,
          `exec nc -U ${f.acp}`,
        ].join("\n"),
      );
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
      return shell(
        [
          `${running(f.tty)} && kill "$(cat ${f.pid})"`,
          `rm -f ${f.pid} ${f.acp} ${f.tty}`,
          `if [ -d ${f.workspace} ]; then (cd ${quote(cwd)} && jj workspace forget ${quote(session)}) 2>/dev/null; rm -rf ${f.workspace}; fi`,
          "true",
        ].join("\n"),
      );
    },
  };
}
