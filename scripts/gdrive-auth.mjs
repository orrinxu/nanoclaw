#!/usr/bin/env node
/**
 * Manual OAuth flow for Google Drive MCP.
 * Prints a URL to open in a browser, then accepts the auth code via stdin.
 * Saves tokens to ~/.config/google-drive-mcp/credentials.json
 */
import fs from 'fs';
import path from 'path';
import https from 'https';
import readline from 'readline';

const configDir = path.join(process.env.HOME, '.config', 'google-drive-mcp');
const keysPath = path.join(configDir, 'gcp-oauth.keys.json');
const tokensPath = path.join(configDir, 'credentials.json');

const keys = JSON.parse(fs.readFileSync(keysPath, 'utf-8'));
const { client_id, client_secret } = keys.installed;

const SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/presentations',
  'https://www.googleapis.com/auth/calendar',
].join(' ');

// Use "urn:ietf:wg:oauth:2.0:oob" equivalent — copy-paste flow
const REDIRECT_URI = 'http://localhost';

const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(client_id)}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=${encodeURIComponent(SCOPES)}&access_type=offline&prompt=consent`;

console.log('\n=== Google Drive OAuth Setup ===\n');
console.log('1. Open this URL in your browser:\n');
console.log(authUrl);
console.log('\n2. Sign in and authorize the app.');
console.log('3. You will be redirected to a URL that starts with http://localhost/?code=...');
console.log('   Copy the ENTIRE URL from your browser address bar and paste it here.\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question('Paste the redirect URL here: ', async (input) => {
  rl.close();

  let code;
  try {
    // Try parsing as URL first
    const url = new URL(input.trim());
    code = url.searchParams.get('code');
  } catch {
    // Maybe they pasted just the code
    code = input.trim();
  }

  if (!code) {
    console.error('Could not extract authorization code. Please try again.');
    process.exit(1);
  }

  console.log('\nExchanging code for tokens...');

  const body = new URLSearchParams({
    code,
    client_id,
    client_secret,
    redirect_uri: REDIRECT_URI,
    grant_type: 'authorization_code',
  }).toString();

  const data = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
      family: 4,
    }, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  if (data.error) {
    console.error(`Error: ${data.error} - ${data.error_description}`);
    process.exit(1);
  }

  // Save tokens
  const tokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    token_type: data.token_type,
    expiry_date: Date.now() + (data.expires_in * 1000),
    scope: data.scope,
  };

  fs.writeFileSync(tokensPath, JSON.stringify(tokens, null, 2));
  console.log(`\nTokens saved to ${tokensPath}`);
  console.log('Google Drive MCP is ready!');
});
