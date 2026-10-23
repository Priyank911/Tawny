const required = ['TAWNY_FIREBASE_API_KEY', 'TAWNY_FIREBASE_PROJECT_ID', 'TAWNY_GOOGLE_CLIENT_ID', 'TAWNY_GOOGLE_CLIENT_SECRET'];
const missing = required.filter((name) => !process.env[name]?.trim());
if (missing.length) {
  console.error(`Configure these GitHub Actions repository secrets before publishing: ${missing.join(', ')}`);
  process.exitCode = 1;
}
