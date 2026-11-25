// Line icons (24 × 24, stroked with currentColor).

const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const icons = {
  mic: svg('<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v4M8 21h8"/>'),
  micOff: svg('<path d="M15 9.3V5a3 3 0 0 0-5.7-1.3M9 9v2a3 3 0 0 0 4.7 2.5M19 10a7 7 0 0 1-1.1 3.8M5 10a7 7 0 0 0 11.5 5.4M12 17v4M8 21h8M3 3l18 18"/>'),
  cam: svg('<rect x="2" y="6" width="14" height="12" rx="2"/><path d="m16 10 6-3v10l-6-3"/>'),
  camOff: svg('<path d="M10.7 6H14a2 2 0 0 1 2 2v3.3l1 1 5-3V17M16 16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2M3 3l18 18"/>'),
  screen: svg('<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4M9 10l3-3 3 3M12 7v6"/>'),
  screenOff: svg('<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4M9.5 7.5l5 5M14.5 7.5l-5 5"/>'),
  chat: svg('<path d="M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-6.4A8 8 0 1 1 21 12z"/>'),
  link: svg('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
  leave: svg('<path d="M4.5 14.5c-1-1-1-2.6 0-3.5C6.8 8.8 9.3 8 12 8s5.2.8 7.5 3c1 1 1 2.5 0 3.5l-1.3 1.3a1 1 0 0 1-1.3.1l-2.2-1.6a1 1 0 0 1-.4-.8V11a10 10 0 0 0-4.6 0v2.5a1 1 0 0 1-.4.8l-2.2 1.6a1 1 0 0 1-1.3-.1z"/>'),
  settings: svg('<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>'),
  close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  send: svg('<path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/>'),
  pin: svg('<path d="M12 17v5M9 3h6l-1 6 4 4H6l4-4z"/>'),
  unpin: svg('<path d="M12 17v5M9 3h6l-1 6 4 4H6l4-4zM3 3l18 18"/>'),
  full: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  people: svg('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6.5 6.5 0 0 1 3.5 6"/>'),
};
