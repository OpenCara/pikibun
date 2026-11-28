export const PROGRAM_RESUME_TOKEN = "OSC7577_TOKEN";

export function withholdProgramResumeToken(env: NodeJS.ProcessEnv = process.env): void {
  delete env[PROGRAM_RESUME_TOKEN];
}
