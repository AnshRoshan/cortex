// The Cortex brand mark — a small neural-node glyph, matching the favicon.
function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label="Cortex"
    >
      <defs>
        <linearGradient id="cortex-logo-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#9576f4" />
          <stop offset="1" stopColor="#6a45ec" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="16" fill="url(#cortex-logo-g)" />
      <g stroke="#fff" strokeWidth="3" strokeLinecap="round" opacity="0.9">
        <line x1="32" y1="32" x2="16" y2="18" />
        <line x1="32" y1="32" x2="48" y2="18" />
        <line x1="32" y1="32" x2="16" y2="46" />
        <line x1="32" y1="32" x2="48" y2="46" />
      </g>
      <g fill="#fff">
        <circle cx="32" cy="32" r="6" />
        <circle cx="16" cy="18" r="4" />
        <circle cx="48" cy="18" r="4" />
        <circle cx="16" cy="46" r="4" />
        <circle cx="48" cy="46" r="4" />
      </g>
    </svg>
  );
}

export default Logo;
