import type { MessagingCommand, ParsedMessagingInput } from "./contracts.js";

export const MAX_MESSAGING_INPUT_BYTES = 64 * 1024;
export const MAX_MESSAGING_SESSION_HANDLE_BYTES = 128;

const SESSION_HANDLE_PATTERN = /^[A-Za-z0-9._:-]+$/;
const COMMAND_HELP = "Commands: !new, !sessions, !use <session>, !status, !help. Prefix ordinary text with !! to send a leading !.";
const UNSAFE_PROMPT_CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const UNPAIRED_SURROGATE_PATTERN = /[\uD800-\uDFFF]/u;
// Reject any default-ignorable prefix (possibly interleaved with whitespace)
// before a bang command, while allowing ZWJ inside ordinary emoji/text later.
const HIDDEN_COMMAND_PREFIX_PATTERN = /^(?=[\p{Default_Ignorable_Code_Point}\s]*\p{Default_Ignorable_Code_Point})[\p{Default_Ignorable_Code_Point}\s]+!/u;

function invalid(
  code: Extract<ParsedMessagingInput, { kind: "invalid" }>["code"],
  message: string,
): ParsedMessagingInput {
  return { kind: "invalid", code, message };
}

function noArguments(name: Exclude<MessagingCommand["name"], "use">, args: string): ParsedMessagingInput {
  if (args) return invalid("invalid_arguments", `!${name} does not accept arguments. ${COMMAND_HELP}`);
  return { kind: "command", command: { name } };
}

/**
 * Parse the portable messaging command grammar. Unknown bang-prefixed input is
 * never passed through to the agent accidentally; `!!` is the explicit escape.
 */
export function parseMessagingInput(body: unknown): ParsedMessagingInput {
  if (typeof body !== "string") {
    return invalid("invalid_input", "Message must be text.");
  }
  if (Buffer.byteLength(body, "utf8") > MAX_MESSAGING_INPUT_BYTES) {
    return invalid("too_large", `Message exceeds the ${MAX_MESSAGING_INPUT_BYTES}-byte limit.`);
  }
  if (UNSAFE_PROMPT_CONTROL_PATTERN.test(body) || UNPAIRED_SURROGATE_PATTERN.test(body)) {
    return invalid("invalid_input", "Message contains unsupported control or malformed Unicode text.");
  }

  const firstNonWhitespace = body.search(/\S/u);
  if (firstNonWhitespace < 0) return invalid("empty", "Message is empty.");

  const meaningful = body.slice(firstNonWhitespace);
  if (HIDDEN_COMMAND_PREFIX_PATTERN.test(meaningful)) {
    return invalid("invalid_input", "Message contains a hidden command prefix.");
  }
  if (meaningful.startsWith("!!")) {
    return {
      kind: "prompt",
      text: `${body.slice(0, firstNonWhitespace)}${meaningful.slice(1)}`,
    };
  }
  if (!meaningful.startsWith("!")) return { kind: "prompt", text: body };

  const trimmed = meaningful.trim();
  const match = trimmed.match(/^!([^\s]+)(?:\s+([\s\S]*))?$/u);
  if (!match) return invalid("unknown_command", COMMAND_HELP);

  const name = match[1]!.toLowerCase();
  const args = (match[2] ?? "").trim();
  switch (name) {
    case "new":
    case "sessions":
    case "status":
    case "help":
      return noArguments(name, args);
    case "use": {
      if (
        !args
        || /\s/u.test(args)
        || Buffer.byteLength(args, "utf8") > MAX_MESSAGING_SESSION_HANDLE_BYTES
        || !SESSION_HANDLE_PATTERN.test(args)
      ) {
        return invalid("invalid_arguments", `Usage: !use <session>. ${COMMAND_HELP}`);
      }
      return { kind: "command", command: { name: "use", sessionHandle: args } };
    }
    default:
      // Never reflect an untrusted command token containing spoofing/control text.
      return invalid("unknown_command", `Unknown command. ${COMMAND_HELP}`);
  }
}
