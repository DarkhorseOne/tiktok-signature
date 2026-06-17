/** 从 argv 解析 --profile <name> / --profile=<name>；无则 undefined */
export function parseProfileArg(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--profile") return argv[i + 1];
    if (a.startsWith("--profile=")) return a.slice("--profile=".length);
  }
  return undefined;
}
