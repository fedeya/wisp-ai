import type { ServerResponse } from 'node:http';

type CallbackResult = 'connected' | 'permission-required' | 'error';

const resultCopy = {
  connected: {
    title: 'ChatGPT connected',
    detail: 'Your ChatGPT account is ready to use in Wisp.',
    nextStep: 'You can close this browser tab.',
    icon: '<path d="m5 12 4 4L19 6"/>',
  },
  'permission-required': {
    title: 'One more step',
    detail: 'Your account is connected. Wisp still needs permission to use your ChatGPT plan.',
    nextStep: 'Select Continue with ChatGPT to grant access.',
    icon: '<path d="M12 7v5l3 2"/><circle cx="12" cy="12" r="9"/>',
  },
  error: {
    title: 'ChatGPT sign-in failed',
    detail: 'Something went wrong while connecting your account.',
    nextStep: 'You can retry sign-in from the app.',
    icon: '<path d="M12 7v5m0 4h.01"/><circle cx="12" cy="12" r="9"/>',
  },
} satisfies Record<
  CallbackResult,
  { title: string; detail: string; nextStep: string; icon: string }
>;

// The desktop app icon (src-tauri/icons/32x32.png), embedded so the loopback
// page can render after its server shuts down and inside the packaged engine.
const wispIcon =
  'data:image/png;base64,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';

export function sendChatGPTCallbackPage(
  res: ServerResponse,
  result: CallbackResult,
  message?: string,
) {
  const { title, detail, nextStep, icon } = resultCopy[result];
  const description = (message ?? detail)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');

  res.writeHead(result === 'error' ? 400 : 200, {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy':
      "default-src 'none'; img-src data:; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    'x-content-type-options': 'nosniff',
  });
  res.end(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} · Wisp</title>
  <link rel="icon" href="${wispIcon}">
  <style>
    :root {
      color-scheme: dark;
      font-family: Inter, "Segoe UI", system-ui, sans-serif;
      color: #e4ebe9;
      background: #14191d;
      --muted: #a5b4b9;
      --border: #2e393e;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      min-height: 100svh;
      display: grid;
      place-items: center;
      padding: 24px;
      background: radial-gradient(ellipse at 50% 32%, #1e3035 0%, transparent 65%);
    }
    main {
      --status: #77dbc6;
      width: min(100%, 440px);
      padding: 36px clamp(20px, 7vw, 36px) 26px;
      border: 1px solid var(--border);
      border-radius: 24px;
      background: radial-gradient(ellipse at 50% 0%, #26363a, transparent 65%), #1c2328;
      box-shadow: 0 24px 70px #08101388;
      text-align: center;
    }
    main.permission-required { --status: #edc789; }
    main.error { --status: #f0a69c; }
    .brand-mark {
      position: relative;
      display: grid;
      place-items: center;
      width: 56px;
      height: 56px;
      margin-inline: auto;
      border: 1px solid #3a5054;
      border-radius: 17px;
      background: linear-gradient(150deg, #294247, #1c282d);
      box-shadow: 0 6px 16px #101a2055, inset 0 1px 0 #ffffff0d;
    }
    .status-icon {
      position: absolute;
      right: -5px;
      bottom: -5px;
      display: grid;
      place-items: center;
      width: 22px;
      height: 22px;
      color: var(--status);
      border: 1px solid color-mix(in srgb, var(--status) 45%, #1c2328);
      border-radius: 50%;
      background: #182225;
      box-shadow: 0 0 0 3px #223034;
    }
    h1 {
      margin: 23px 0 8px;
      font-size: clamp(24px, 6vw, 32px);
      font-weight: 650;
      line-height: 1.15;
      letter-spacing: -0.035em;
      text-wrap: balance;
    }
    p {
      margin: 0;
      color: var(--muted);
      font-size: 15px;
      line-height: 1.55;
      overflow-wrap: anywhere;
    }
    .next-step {
      margin-top: 24px;
      padding-top: 17px;
      border-top: 1px solid var(--border);
    }
    .next-step svg { color: #77dbc6; }
    .next-step strong {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 7px;
      margin-bottom: 3px;
      color: #e4ebe9;
      font-size: 14px;
      font-weight: 650;
    }
    .next-step p { font-size: 13px; }
  </style>
</head>
<body>
  <main class="${result}" aria-labelledby="result-title">
    <div class="brand-mark">
      <img src="${wispIcon}" width="36" height="36" alt="Wisp">
      <span class="status-icon" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icon}</svg>
      </span>
    </div>
    <h1 id="result-title">${title}</h1>
    <p>${description}</p>
    <div class="next-step">
      <strong>
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="4" width="18" height="13" rx="2"/>
          <path d="M12 17v3m-4 0h8"/>
        </svg>
        Return to Wisp
      </strong>
      <p>${nextStep}</p>
    </div>
  </main>
</body>
</html>`);
}
