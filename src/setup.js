import readline from 'node:readline';
import { Writable } from 'node:stream';
import argon2 from 'argon2';
import { db } from './db.js';

const isTTY = Boolean(process.stdin.isTTY);

async function readNonTTY() {
  let buf = '';
  for await (const chunk of process.stdin) buf += chunk.toString('utf8');
  return buf.split(/\r?\n/);
}

function askerTTY() {
  let mute = false;
  const output = new Writable({
    write(chunk, encoding, cb) {
      if (!mute) process.stdout.write(chunk, encoding);
      cb();
    },
  });
  const rl = readline.createInterface({
    input: process.stdin,
    output,
    terminal: true,
  });
  return {
    ask(question, { muted = false } = {}) {
      return new Promise((resolve) => {
        process.stdout.write(question);
        mute = muted;
        rl.question('', (answer) => {
          if (mute) process.stdout.write('\n');
          mute = false;
          resolve(answer);
        });
      });
    },
    close() {
      rl.close();
    },
  };
}

async function main() {
  console.log('Budget Tracker — setup');

  const existing = db.prepare('SELECT id, username FROM users LIMIT 1').get();

  let answers;
  if (isTTY) {
    const { ask, close } = askerTTY();
    try {
      if (existing) {
        const yn = (await ask(`User "${existing.username}" already exists. Overwrite? [y/N] `))
          .trim()
          .toLowerCase();
        if (yn !== 'y') {
          console.log('Aborted.');
          close();
          process.exit(0);
        }
      }
      const username = (await ask('Username: ')).trim();
      const password = await ask('Password: ', { muted: true });
      answers = { username, password };
    } finally {
      close();
    }
  } else {
    const lines = await readNonTTY();
    let i = 0;
    if (existing) {
      const yn = (lines[i++] || '').trim().toLowerCase();
      if (yn !== 'y') {
        console.log('Aborted.');
        process.exit(0);
      }
    }
    const username = (lines[i++] || '').trim();
    const password = lines[i++] || '';
    answers = { username, password };
  }

  const { username, password } = answers;
  if (!username) {
    console.error('Username cannot be empty.');
    process.exit(1);
  }
  if (!password) {
    console.error('Password cannot be empty.');
    process.exit(1);
  }

  const hash = await argon2.hash(password, { type: argon2.argon2id });

  if (existing) {
    db.prepare('UPDATE users SET username = ?, password_hash = ? WHERE id = ?')
      .run(username, hash, existing.id);
  } else {
    db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
      .run(username, hash);
  }

  console.log(`User "${username}" ready. You can now start the server.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Setup failed:', err);
  process.exit(1);
});
