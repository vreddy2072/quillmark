import type { ReactNode } from "react";

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const icons = {
  open: (
    <Icon>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1" />
      <path d="M3 7v11a2 2 0 0 0 2 2h13.5a2 2 0 0 0 1.9-1.4L22 12H7.6a2 2 0 0 0-1.9 1.4L3 20" />
    </Icon>
  ),
  save: (
    <Icon>
      <path d="M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
      <path d="M7 3v5h8V3" />
      <rect x="7" y="13" width="10" height="8" rx="1" />
    </Icon>
  ),
  select: (
    <Icon>
      <path d="M5 3l14 7-6 2-2 6z" />
    </Icon>
  ),
  text: (
    <Icon>
      <path d="M5 6V4h14v2" />
      <path d="M12 4v16" />
      <path d="M9 20h6" />
    </Icon>
  ),
  marker: (
    <Icon>
      <path d="M15 4l5 5L9 20H4v-5z" />
      <path d="M13 6l5 5" />
    </Icon>
  ),
  highlight: (
    <Icon>
      <path d="M9 11l-5 5v4h4l5-5" />
      <path d="M14 4l6 6-7 7-6-6z" />
      <path d="M3 22h8" />
    </Icon>
  ),
  image: (
    <Icon>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="M21 15l-5-5L5 21" />
    </Icon>
  ),
  undo: (
    <Icon>
      <path d="M9 14L4 9l5-5" />
      <path d="M4 9h11a5 5 0 0 1 0 10h-3" />
    </Icon>
  ),
  redo: (
    <Icon>
      <path d="M15 14l5-5-5-5" />
      <path d="M20 9H9a5 5 0 0 0 0 10h3" />
    </Icon>
  ),
  trash: (
    <Icon>
      <path d="M4 7h16" />
      <path d="M10 11v6M14 11v6" />
      <path d="M6 7l1 13h10l1-13" />
      <path d="M9 7V4h6v3" />
    </Icon>
  ),
  zoomIn: (
    <Icon>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3M11 8v6M8 11h6" />
    </Icon>
  ),
  zoomOut: (
    <Icon>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3M8 11h6" />
    </Icon>
  ),
  file: (
    <Icon>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </Icon>
  ),
  rotateLeft: (
    <Icon>
      <path d="M3 4v5h5" />
      <path d="M3.5 13a8.5 8.5 0 1 0 2.2-6.3L3 9" />
    </Icon>
  ),
  rotateRight: (
    <Icon>
      <path d="M21 4v5h-5" />
      <path d="M20.5 13a8.5 8.5 0 1 1-2.2-6.3L21 9" />
    </Icon>
  ),
  sign: (
    <Icon>
      <path d="M3 17c3-1 4-9 6-9s-1 9 1 9 3-5 4-5 0 4 2 4 3-2 5-2" />
      <path d="M3 21h18" />
    </Icon>
  ),
  check: (
    <Icon>
      <path d="M4 12.5l5 5L20 6.5" />
    </Icon>
  ),
  cross: (
    <Icon>
      <path d="M6 6l12 12M18 6L6 18" />
    </Icon>
  ),
  whiteout: (
    <Icon>
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="M7 12h6" />
      <path d="M16 10v4" />
    </Icon>
  ),
  search: (
    <Icon>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </Icon>
  ),
  print: (
    <Icon>
      <path d="M6 9V3h12v6" />
      <rect x="3" y="9" width="18" height="8" rx="2" />
      <path d="M6 14h12v7H6z" />
    </Icon>
  ),
  sidebar: (
    <Icon>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </Icon>
  ),
  up: (
    <Icon>
      <path d="M6 15l6-6 6 6" />
    </Icon>
  ),
  down: (
    <Icon>
      <path d="M6 9l6 6 6-6" />
    </Icon>
  ),
  close: (
    <Icon>
      <path d="M6 6l12 12M18 6L6 18" />
    </Icon>
  ),
  calendar: (
    <Icon>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </Icon>
  ),
  plus: (
    <Icon>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  ),
  chevron: (
    <Icon>
      <path d="M7 10l5 5 5-5" />
    </Icon>
  ),
  saveAs: (
    <Icon>
      <path d="M5 3h11l5 5v5" />
      <path d="M3 5v14a2 2 0 0 0 2 2h7" />
      <path d="M7 3v5h8V3" />
      <path d="M17 15v6M14 18h6" />
    </Icon>
  ),
};
