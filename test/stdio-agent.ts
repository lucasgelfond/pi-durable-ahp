// The test host as an editor starts an ACP agent: on this process's stdin and stdout (acp.test.ts).
import { serve } from "./support.ts";

const { ahp } = await serve();
ahp.acp({ cwd: "/work" }).stdio();
