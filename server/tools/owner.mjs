#!/usr/bin/env node
/* The owner's password for the Quriliş Go panel.
     node tools/owner.mjs hash            asks for a password (not echoed) and prints the OWNER_PASSWORD_HASH line for .env
     node tools/owner.mjs hash --stdin    reads the password from stdin (used by `imorat owner`, so it never appears in argv or history)
     node tools/owner.mjs check HASH      asks for a password and says whether it matches the hash
   The password itself is never written anywhere: only the scrypt hash goes to server/.env (OWNER_PASSWORD_HASH), next to OWNER_LOGIN. */
import { hashPassword, verifyPassword } from "../src/auth.js";
import { createInterface } from "node:readline";

const ask = (q, hidden) => new Promise(res => {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  if (hidden) { const w = rl._writeToOutput; rl._writeToOutput = s => { if (/\n/.test(s)) w.call(rl, "\n"); }; process.stderr.write(q); }
  rl.question(hidden ? "" : q, a => { rl.close(); res(a); });
});
const readStdin = () => new Promise(res => { let d = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", c => { d += c; }); process.stdin.on("end", () => res(d.replace(/\r?\n$/, ""))); });

const [cmd, ...args] = process.argv.slice(2);
if (cmd === "hash") {
  let pw;
  if (args.includes("--stdin")) pw = await readStdin();
  else { pw = await ask("Password for the owner's panel sign-in (min 10 characters, not shown): ", true); const again = await ask("Once more: ", true); if (pw !== again) { console.error("The two passwords differ"); process.exit(2); } }
  let hash; try { hash = hashPassword(pw); } catch (e) { console.error(e.message); process.exit(2); }
  console.log(hash);
} else if (cmd === "check") {
  const pw = await ask("Password: ", true);
  console.log(verifyPassword(pw, args[0]) ? "matches" : "does NOT match"); process.exit(verifyPassword(pw, args[0]) ? 0 : 1);
} else {
  console.error("usage: node tools/owner.mjs hash [--stdin] | check HASH"); process.exit(2);
}
