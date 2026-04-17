const SB_URL = 'https://bgsvuywxejpmkstgqizq.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJnc3Z1eXd4ZWpwbWtzdGdxaXpxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE2MDc0MzMsImV4cCI6MjA4NzE4MzQzM30.EvHOy5sBbXzSxjRS5vPGzm8cnFrOXxDfclP-ru3VU_M';
const APP_URL = 'https://screencast-eight.vercel.app';

const $ = id => document.getElementById(id);
const loginView = $('login-view');
const mainView  = $('main-view');

chrome.storage.local.get(['token', 'userId', 'email'], s => {
  if (s.token) showMain(s.email);
  else showLogin();
});

function showLogin() {
  loginView.style.display = 'flex';
  mainView.style.display  = 'none';
}
function showMain(email) {
  loginView.style.display = 'none';
  mainView.style.display  = 'flex';
  $('u-email').textContent = email || '';
}

$('signin-btn').addEventListener('click', async () => {
  const email = $('email').value.trim();
  const pwd   = $('pwd').value;
  if (!email || !pwd) { showErr('Enter email and password'); return; }
  $('signin-btn').disabled = true;
  $('signin-btn').textContent = 'Signing in…';
  $('err').style.display = 'none';
  try {
    const r = await fetch(`${SB_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SB_KEY },
      body: JSON.stringify({ email, password: pwd }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error_description || d.msg || 'Sign in failed');
    await chrome.storage.local.set({ token: d.access_token, userId: d.user.id, email: d.user.email });
    showMain(d.user.email);
  } catch (e) {
    showErr(e.message);
    $('signin-btn').disabled = false;
    $('signin-btn').textContent = 'Sign In';
  }
});

$('out-btn').addEventListener('click', async () => {
  await chrome.storage.local.remove(['token', 'userId', 'email']);
  showLogin();
});

$('rec-btn').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('recorder/recorder.html') });
  window.close();
});

$('dash-btn').addEventListener('click', () => {
  chrome.tabs.create({ url: `${APP_URL}/dashboard` });
  window.close();
});

function showErr(msg) {
  const el = $('err');
  el.textContent = msg;
  el.style.display = 'block';
}
