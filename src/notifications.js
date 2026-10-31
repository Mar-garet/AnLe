import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const exec = promisify(execFile);
const appleScript = 'on run argv\n  display notification (item 1 of argv) with title "AnLe"\nend run';

export async function notifyHumanMessages(messages, {platform = process.platform, run = exec} = {}) {
  if (!messages.length) return false;
  const message = messages.length === 1 ? `New message from ${messages[0].sender_name} · ${messages[0].space_name}` :
    `${messages.length} new messages in your inbox`;
  if (platform === 'darwin') await run('/usr/bin/osascript', ['-e', appleScript, message], {timeout: 5000});
  else if (platform === 'linux') await run('notify-send', ['AnLe', message], {timeout: 5000});
  else return false;
  return true;
}
