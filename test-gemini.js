// Quick Gemini API key tester
// Usage: node test-gemini.js YOUR_API_KEY
const key = process.argv[2];
if (!key) { console.error('Usage: node test-gemini.js YOUR_API_KEY'); process.exit(1); }

console.log('Testing Gemini API key...');
fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ contents: [{ parts: [{ text: 'Say "API key works!" and nothing else.' }] }] })
})
.then(r => r.json())
.then(data => {
  if (data.error) {
    console.error('❌ Error:', data.error.message);
    if (data.error.status === 'PERMISSION_DENIED') console.error('   → Key is invalid or not yet active.');
    if (data.error.status === 'RESOURCE_EXHAUSTED') console.error('   → Quota exceeded. Try again later.');
  } else {
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    console.log('✅ Success! Response:', text);
  }
})
.catch(err => console.error('❌ Network error:', err.message));
