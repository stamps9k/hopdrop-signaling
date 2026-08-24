import { randomInt } from "node:crypto";

// Excludes visually ambiguous characters (0/O, 1/I/L) to reduce
// transcription errors when a user types a code read off another device.
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const DEFAULT_CODE_LENGTH = 6;

/**
 * Generates a cryptographically random, high-entropy room code.
 *
 * Uses crypto.randomInt (CSPRNG) rather than Math.random so codes can't be
 * predicted or brute-forced — room codes are the only thing standing
 * between an attacker and joining a pairing session.
 */
export function generate_room_code(length: number = DEFAULT_CODE_LENGTH): string {
  if (length < 1) {
    throw new RangeError(`room code length must be >= 1, got ${length}`);
  }

  let code = "";
  for (let i = 0; i < length; i++) {
    const index = randomInt(0, CODE_ALPHABET.length);
    code += CODE_ALPHABET[index];
  }
  return code;
}

/**
 * Validates that a candidate string is a well-formed room code: correct
 * length and composed only of characters from CODE_ALPHABET. Does NOT
 * check whether the code corresponds to an active room — that's rooms.mts's
 * job. Used to reject malformed input early, before it reaches room lookup.
 */
export function is_valid_room_code(
  candidate: string,
  length: number = DEFAULT_CODE_LENGTH,
): boolean {
  if (candidate.length !== length) {
    return false;
  }
  for (const char of candidate) {
    if (!CODE_ALPHABET.includes(char)) {
      return false;
    }
  }
  return true;
}
