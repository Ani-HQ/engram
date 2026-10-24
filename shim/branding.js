'use strict';

// Public connector identity only. Never copy credentials or request parameters
// into metadata that a host may fetch or display before authentication.
function connectorBranding(host) {
  let url;
  try { url = new URL(host); } catch { throw new TypeError('Engram branding requires an HTTP(S) origin'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
    throw new TypeError('Engram branding requires an HTTP(S) origin');
  }
  const origin = url.origin;
  return {
    name: 'engram',
    title: 'Engram',
    version: '0.1.0',
    description: 'Shared memory and activity across your agents.',
    websiteUrl: `${origin}/`,
    icons: [
      { src: `${origin}/brand/engram-mark.png`, mimeType: 'image/png', sizes: ['512x512'] },
      { src: `${origin}/brand/engram-mark.svg`, mimeType: 'image/svg+xml', sizes: ['any'] },
    ],
  };
}

module.exports = { connectorBranding };
