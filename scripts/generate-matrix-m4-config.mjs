#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { closeSync, constants, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!key?.startsWith("--") || !value) throw new Error("Expected exact --project and --profile arguments");
  args.set(key, value);
}
if (args.size !== 2 || !args.has("--project") || !args.has("--profile")) {
  throw new Error("Expected exact --project and --profile arguments");
}
const stableId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const projectId = args.get("--project");
const profileId = args.get("--profile");
if (!stableId.test(projectId) || !stableId.test(profileId)) throw new Error("Project/Profile IDs must be canonical UUIDs");

const wayangPath = "/home/clemente/.config/wayang/messaging.json";
const registrationPath = "/home/clemente/src/server-lattice/matrix/appservices/wayang.yaml";
const hsToken = randomBytes(48).toString("base64url");
const asToken = randomBytes(48).toString("base64url");
const wayang = {
  version: 1,
  matrix: {
    homeserverOrigin: "http://127.0.0.1:6167",
    serverName: "chat.narwhalzero.net",
    applicationServiceId: "wayang",
    senderLocalpart: "wayang_as",
    userPrefix: "wayang_user_",
    aliasPrefix: "wayang_room_",
    hsToken,
    asToken,
  },
  wayangBaseUrl: "https://wayang.narwhalzero.net",
  endpoints: [{
    endpointId: "matrix-rehearsal",
    connectorId: "matrix",
    provisioningKey: "matrix-rehearsal",
    projectId,
    agentProfileId: profileId,
    displayName: "Matrix Rehearsal",
    conversationMode: "shared",
    allowedSubjectIds: ["@clemente:chat.narwhalzero.net"],
    transportSecurity: "unencrypted_accepted",
  }],
};
const registration = [
  "id: wayang",
  "url: http://192.168.240.1:8790",
  `as_token: ${asToken}`,
  `hs_token: ${hsToken}`,
  "sender_localpart: wayang_as",
  "rate_limited: false",
  "receive_ephemeral: false",
  "namespaces:",
  "  users:",
  "    - exclusive: true",
  "      regex: '^@wayang_as:chat\\.narwhalzero\\.net$'",
  "    - exclusive: true",
  "      regex: '^@wayang_user_[0-9a-f]{64}:chat\\.narwhalzero\\.net$'",
  "  aliases:",
  "    - exclusive: true",
  "      regex: '^#wayang_room_[0-9a-f]{64}:chat\\.narwhalzero\\.net$'",
  "  rooms: []",
  "",
].join("\n");

function writePrivateAtomic(destination, contents) {
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const temp = `${destination}.${process.pid}.tmp`;
  let fd;
  try {
    fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeFileSync(fd, contents, "utf8");
    closeSync(fd);
    fd = undefined;
    renameSync(temp, destination);
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temp, { force: true });
  }
}

try {
  openSync(wayangPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  throw new Error("Wayang messaging config already exists; refusing to overwrite");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
try {
  openSync(registrationPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  throw new Error("Tuwunel Wayang registration already exists; refusing to overwrite");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

writePrivateAtomic(wayangPath, `${JSON.stringify(wayang, null, 2)}\n`);
try {
  writePrivateAtomic(registrationPath, registration);
} catch (error) {
  rmSync(wayangPath, { force: true });
  throw error;
}
console.log("Created owner-private Wayang and Tuwunel Matrix artifacts with independent 64-character tokens.");
