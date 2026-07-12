const fs = require('fs');
const path = require('path');
const { FormData, File } = globalThis;

async function main() {
  const filePath = path.join(process.cwd(), 'index.html');
  const fileStream = fs.createReadStream(filePath);
  const form = new FormData();
  form.append('file', fileStream, 'index.html');
  form.append('auth_token', 'token-1');

  const response = await fetch('http://localhost:3010/api/settings/upload-image/hero_image', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer token-1',
      'x-auth-token': 'token-1'
    },
    body: form
  });

  const text = await response.text();
  console.log('status=' + response.status);
  console.log(text);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
