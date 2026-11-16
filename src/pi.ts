import { fileURLToPath } from "node:url";
import type { AcpProvider } from "./acp-chat.ts";

// pi's own TUI as an ACP agent's session (pi/acp.ts): each session one pi, kept running under dtach in its place
// (here, or in a box `shell` reaches), in a jj workspace of its own when its working directory is a jj repo. The
// host's connection is the same script every time: it starts the session's pi if it isn't running (`--session-id` the
// session's, so a restarted pi carries on from its session file), waits for its socket, and becomes the bridge to it.
// Anyone can open the same pi's terminal with the session's _meta.pi.attach, and what's typed there shows in the chat.

export interface PiOptions {
  id?: string;
  displayName?: string;
  // Where the sessions' sockets and workspaces go, in the place `shell` runs.
  dir: string;
  // pi's command line there, and the extension's path there.
  pi?: string[];
  extension?: string;
  // A script's command line in the place: `sh -c` here by default; ssh into a box, say.
  shell?: (script: string) => string[];
}

const EXTENSION = fileURLToPath(new URL("../pi/acp.ts", import.meta.url));
// The longest path a Unix socket can have (macOS's; Linux allows 107).
const SOCKET_MAX = 103;
const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

export function piAgent(opts: PiOptions): AcpProvider {
  const shell = opts.shell ?? ((script: string) => ["sh", "-c", script]);
  const command = [...(opts.pi ?? ["pi"]), "-e", opts.extension ?? EXTENSION].map(quote).join(" ");
  // A session's files there, quoted for its scripts.
  const files = (session: string) => {
    const run = `${opts.dir}/run/${session}`;
    return { run: quote(`${opts.dir}/run`), workspaces: quote(`${opts.dir}/workspaces`), tty: quote(`${run}.tty`), acp: quote(`${run}.sock`), pid: quote(`${run}.pid`), workspace: quote(`${opts.dir}/workspaces/${session}`) };
  };
  // Whether the session's pi is running: its terminal's socket takes a connection (one left by a crash or a reboot
  // doesn't, and a pid may have been reused since).
  const running = (tty: string) => `dtach -p ${tty} </dev/null 2>/dev/null`;
  return {
    id: opts.id ?? "pi",
    displayName: opts.displayName ?? "pi",
    description: "pi in its own terminal",
    follow: true,
    connect(session, cwd) {
      const socket = `${opts.dir}/run/${session}.sock`;
      if (Buffer.byteLength(socket) > SOCKET_MAX) throw new Error(`${socket} is too long for a Unix socket: give pi a shorter dir than ${opts.dir}`);
      const f = files(session);
      return shell(
        [
          "set -e",
          `mkdir -p ${f.run} ${f.workspaces}`,
          `cd ${quote(cwd)}`,
          `if [ -d .jj ]; then [ -d ${f.workspace} ] || jj workspace add --quiet --name ${quote(session)} ${f.workspace}; cd ${f.workspace}; fi`,
          `if ! ${running(f.tty)}; then`,
          `  rm -f ${f.acp} ${f.tty}`,
          `  PI_ACP_SOCKET=${f.acp} dtach -n ${f.tty} -z sh -c ${quote(`echo $$ > ${f.pid}; exec ${command} --session-id ${quote(session)}`)}`,
          "fi",
          `i=0; until [ -S ${f.acp} ]; do i=$((i+1)); [ $i -lt 600 ] || { echo "pi didn't start" >&2; exit 1; }; sleep 0.05; done`,
          `exec nc -U ${f.acp}`,
        ].join("\n"),
      );
    },
    meta: (session) => ({ pi: { attach: shell(`exec dtach -a ${files(session).tty} -r winch -z`) } }),
    dispose(session, cwd) {
      const f = files(session);
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
