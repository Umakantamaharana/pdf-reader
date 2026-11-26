/**
 * schema.ts — Single source of truth for the settings model.
 *
 * Everything the extension does is described here: feature toggles, colors,
 * TTS config, UI state, and the canonical command registry (with default
 * keybindings). The SettingsManager deep-merges stored data over DEFAULT_SETTINGS,
 * so adding a new field here automatically back-fills existing users on upgrade.
 */

export const SCHEMA_VERSION = 2;

/** A keybinding is a chord ("ctrl+shift+k") or a Vim-style sequence ("g g"). */
export type KeyBinding = string;

export type LayoutMode = 'single' | 'two-page' | 'continuous';
export type FitMode = 'width' | 'height' | 'page' | 'auto' | 'actual';
export type InvertMode = 'off' | 'smart-invert' | 'custom-colors';
export type ToolbarPosition = 'floating' | 'docked-top' | 'docked-bottom';
export type TtsEngine = 'kokoro' | 'piper' | 'native';
export type HighlightGranularity = 'word' | 'sentence';
export type Theme = 'system' | 'light' | 'dark';

export interface ColorPreset {
  id: string;
  name: string;
  background: string; // CSS color for the page backdrop
  foreground: string; // CSS color for text/foreground after inversion
  /** Brightness/contrast this preset applies when chosen. */
  brightness?: number;
  contrast?: number;
}

/** Font families offered for text boxes / notes (all local, no web fonts). */
export type FontFamily = 'sans' | 'serif' | 'mono' | 'hand';

/** Annotation colour per tool family (see AppSettings.annotation.colors). */
export interface ToolColors {
  highlight: string;
  mark: string; // underline + strikethrough
  pen: string;
  shape: string; // box, circle, arrow
  text: string; // text box
  note: string; // sticky-note marker
}

export interface AppSettings {
  meta: {
    schemaVersion: number;
    storageMode: 'local' | 'sync'; // where to persist; local is default (sync has a 100KB cap)
  };

  general: {
    rememberLastPage: boolean;
    restoreZoom: boolean;
    confirmOnExport: boolean;
    telemetry: boolean; // always default false; local-only, never networked unless user opts in
  };

  viewing: {
    layoutMode: LayoutMode;
    fitMode: FitMode;
    smoothScroll: boolean;
    defaultZoom: number; // 1 = 100%
    defaultRotation: 0 | 90 | 180 | 270;
    presentationMode: boolean;
    sidebar: {
      visible: boolean;
      activeTab: 'thumbnails' | 'outline' | 'bookmarks';
      width: number;
    };
  };

  search: {
    highlightAll: boolean;
    caseSensitive: boolean;
    regex: boolean;
    wholeWords: boolean;
  };

  darkMode: {
    enabled: boolean;
    mode: InvertMode;
    /** Protect photos/diagrams from looking like negatives when inverting. */
    smartImageProtection: boolean;
    brightness: number; // 0.5 .. 1.5
    contrast: number; // 0.5 .. 1.5
    activePresetId: string;
    presets: ColorPreset[];
  };

  annotation: {
    enabled: boolean;
    defaultTool: 'none' | 'highlight' | 'underline' | 'strikethrough' | 'pen' | 'rectangle' | 'arrow' | 'note' | 'textbox' | 'stamp';
    highlightColor: string;
    highlightOpacity: number;
    penColor: string;
    penWidth: number;
    shapeColor: string;
    /**
     * Colour per tool, kept separately for each theme so a pick made on a dark
     * page doesn't leak into light mode (and vice versa). Values are what the
     * user sees on screen in that theme. Supersedes highlight/pen/shapeColor.
     */
    colors: { light: ToolColors; dark: ToolColors };
    /** Default font for new text boxes and sticky notes. */
    textStyle: { family: FontFamily; size: number };
    autosave: boolean;
    middleClickEraser: {
      enabled: boolean;
      /** When true the wheel-click erases even outside annotation mode. */
      global: boolean;
      radius: number; // px hit-test radius for drag-erase
      eraseWholeStroke: boolean; // true = delete entire stroke on hit; false = cut segment
    };
  };

  tts: {
    enabled: boolean;
    engine: TtsEngine;
    voice: string; // engine-specific voice id, e.g. "af_bella"
    speed: number; // 0.5 .. 2.0
    pitch: number; // native engine only
    highlightGranularity: HighlightGranularity;
    highlightWhileReading: boolean;
    preloadModelOnStart: boolean;
    fallbackToNativeWhileLoading: boolean;
    sentencePauseMs: number;
    preferWebGPU: boolean; // fall back to WASM automatically if unavailable
    /** Read like a person: skip chart/axis labels, tables of numbers, running
     *  headers/footers, page numbers and tiny print. */
    skipNonProse: boolean;
    /** Where the neural voice runs. 'auto' = GPU, falling back to CPU if it fails. */
    device: 'auto' | 'gpu' | 'cpu';
    /** 'clean' reads symbols/abbreviations as words and drops citations, URLs, maths. */
    readingMode: 'clean' | 'verbatim';
    /** Sentences to synthesise ahead of playback ('off' or a count). */
    lookahead: 'off' | '1' | '2' | '3' | '5';
  };

  ui: {
    theme: Theme;
    toolbarVisible: boolean;
    toolbarPosition: ToolbarPosition;
    density: 'comfortable' | 'compact';
    showStatusBar: boolean;
    distractionFree: boolean; // master hide-everything toggle
  };

  commandPalette: {
    enabled: boolean;
    fuzzy: boolean;
    recentCount: number;
  };

  shortcuts: {
    enabled: boolean;
    vimEnabled: boolean;
    leaderKey: string; // e.g. "," — begins a leader sequence
    sequenceTimeoutMs: number; // window to complete a multi-key Vim sequence
    ignoreWhenTypingInInputs: boolean;
    /** Overrides keyed by command id. Missing id => use the command's defaultKeys. */
    keymap: Record<string, KeyBinding>;
  };
}

/** A user-triggerable action. The Command Palette and ShortcutManager both read this. */
export interface Command {
  id: string;
  title: string;
  category: 'Navigation' | 'View' | 'Dark Mode' | 'Annotation' | 'TTS' | 'Search' | 'Settings' | 'General';
  defaultKeys: KeyBinding;
  /** Optional guard expression evaluated against runtime context (e.g. "annotation.enabled"). */
  when?: string;
}

/** The single built-in dark theme: full brightness, softened contrast (0.6)
 *  so inverted pages read as light-grey text on charcoal rather than harsh
 *  white-on-black. */
export const SOFT_NIGHT: ColorPreset = {
  id: 'soft-night',
  name: 'Soft Night',
  background: '#1b1c1f',
  foreground: '#cccccc',
  brightness: 1,
  contrast: 0.6,
};
export const DEFAULT_PRESETS: ColorPreset[] = [SOFT_NIGHT];

/**
 * Canonical command registry. Keep ids stable — they are persisted in keymaps
 * and recent-command history. Add new commands by appending here.
 */
export const COMMANDS: Command[] = [
  // Navigation
  { id: 'nav.nextPage', title: 'Next Page', category: 'Navigation', defaultKeys: 'right | j' },
  { id: 'nav.prevPage', title: 'Previous Page', category: 'Navigation', defaultKeys: 'left | k' },
  { id: 'nav.firstPage', title: 'Go to First Page', category: 'Navigation', defaultKeys: 'home | g g' },
  { id: 'nav.lastPage', title: 'Go to Last Page', category: 'Navigation', defaultKeys: 'end | shift+g' },
  { id: 'nav.gotoPage', title: 'Go to Page…', category: 'Navigation', defaultKeys: 'ctrl+g' },
  { id: 'nav.scrollDown', title: 'Scroll Down (one screen)', category: 'Navigation', defaultKeys: 'space | d' },
  { id: 'nav.scrollUp', title: 'Scroll Up (one screen)', category: 'Navigation', defaultKeys: 'shift+space | u' },
  { id: 'nav.lineDown', title: 'Scroll Down (line)', category: 'Navigation', defaultKeys: 'down' },
  { id: 'nav.lineUp', title: 'Scroll Up (line)', category: 'Navigation', defaultKeys: 'up' },

  // View
  { id: 'view.zoomIn', title: 'Zoom In', category: 'View', defaultKeys: 'ctrl+= | ctrl+plus' },
  { id: 'view.zoomOut', title: 'Zoom Out', category: 'View', defaultKeys: 'ctrl+-' },
  { id: 'view.fitWidth', title: 'Fit to Width', category: 'View', defaultKeys: 'ctrl+2 | w' },
  { id: 'view.fitPage', title: 'Fit Whole Page', category: 'View', defaultKeys: 'ctrl+3' },
  { id: 'view.rotateCW', title: 'Rotate Clockwise', category: 'View', defaultKeys: 'r | ctrl+]' },
  { id: 'view.rotateCCW', title: 'Rotate Counter-Clockwise', category: 'View', defaultKeys: 'shift+r | ctrl+[' },
  { id: 'view.cycleLayout', title: 'Cycle Layout (Single/Two/Continuous)', category: 'View', defaultKeys: 'l' },
  { id: 'view.presentation', title: 'Toggle Presentation Mode', category: 'View', defaultKeys: 'f5' },
  { id: 'view.toggleSidebar', title: 'Toggle Sidebar', category: 'View', defaultKeys: 's | f4' },
  { id: 'view.toggleToolbar', title: 'Toggle Toolbar', category: 'View', defaultKeys: 't | f8' },
  { id: 'view.distractionFree', title: 'Toggle Distraction-Free Mode', category: 'View', defaultKeys: 'z z' },

  // Dark Mode
  { id: 'dark.toggle', title: 'Toggle Dark / Invert', category: 'Dark Mode', defaultKeys: 'shift+d' },
  { id: 'dark.panel', title: 'Open Night Mode Toolbar', category: 'Dark Mode', defaultKeys: 'alt+shift+d' },
  { id: 'dark.cyclePreset', title: 'Cycle Color Preset', category: 'Dark Mode', defaultKeys: 'shift+p' },
  { id: 'dark.brightnessUp', title: 'Increase Brightness', category: 'Dark Mode', defaultKeys: 'alt+]' },
  { id: 'dark.brightnessDown', title: 'Decrease Brightness', category: 'Dark Mode', defaultKeys: 'alt+[' },

  // Annotation
  { id: 'annot.toggleMode', title: 'Toggle Annotation Mode', category: 'Annotation', defaultKeys: 'a' },
  { id: 'annot.highlight', title: 'Highlight Tool', category: 'Annotation', defaultKeys: 'h' },
  { id: 'annot.underline', title: 'Underline Tool', category: 'Annotation', defaultKeys: 'shift+u' },
  { id: 'annot.strike', title: 'Strikethrough Tool', category: 'Annotation', defaultKeys: 'shift+s' },
  { id: 'annot.pen', title: 'Pen Tool', category: 'Annotation', defaultKeys: 'p' },
  { id: 'annot.rectangle', title: 'Rectangle / Box Tool', category: 'Annotation', defaultKeys: 'shift+o' },
  { id: 'annot.ellipse', title: 'Circle / Ellipse Tool', category: 'Annotation', defaultKeys: 'shift+c' },
  { id: 'annot.arrow', title: 'Arrow Tool', category: 'Annotation', defaultKeys: 'shift+a' },
  { id: 'annot.note', title: 'Sticky Note', category: 'Annotation', defaultKeys: 'n' },
  { id: 'annot.textbox', title: 'Text Box', category: 'Annotation', defaultKeys: 'shift+t' },
  { id: 'annot.stamp', title: 'Image / Signature Stamp', category: 'Annotation', defaultKeys: 'shift+m' },
  { id: 'annot.eraser', title: 'Eraser Tool', category: 'Annotation', defaultKeys: 'e' },
  { id: 'annot.undo', title: 'Undo', category: 'Annotation', defaultKeys: 'ctrl+z' },
  { id: 'annot.redo', title: 'Redo', category: 'Annotation', defaultKeys: 'ctrl+shift+z | ctrl+y' },
  { id: 'annot.export', title: 'Export Annotated PDF', category: 'Annotation', defaultKeys: 'ctrl+s' },

  // TTS
  { id: 'tts.playPause', title: 'Read Aloud: Play / Pause', category: 'TTS', defaultKeys: 'ctrl+shift+u | mediaplaypause' },
  { id: 'tts.stop', title: 'Stop Reading', category: 'TTS', defaultKeys: 'mediastop' },
  { id: 'tts.nextSentence', title: 'Next Sentence', category: 'TTS', defaultKeys: 'ctrl+right | mediatracknext' },
  { id: 'tts.prevSentence', title: 'Previous Sentence', category: 'TTS', defaultKeys: 'ctrl+left | mediatrackprevious' },
  { id: 'tts.speedUp', title: 'Speak Faster', category: 'TTS', defaultKeys: ']' },
  { id: 'tts.speedDown', title: 'Speak Slower', category: 'TTS', defaultKeys: '[' },
  { id: 'tts.readFromCursor', title: 'Read From Selection / Cursor', category: 'TTS', defaultKeys: 'shift+enter' },

  // Search
  { id: 'search.open', title: 'Find in Document', category: 'Search', defaultKeys: 'ctrl+f' },
  { id: 'search.openSlash', title: 'Find (Vim)', category: 'Search', defaultKeys: '/' },
  { id: 'search.next', title: 'Next Match', category: 'Search', defaultKeys: 'f3' },
  { id: 'search.prev', title: 'Previous Match', category: 'Search', defaultKeys: 'shift+f3' },

  // Settings / General
  { id: 'app.commandPalette', title: 'Open Command Palette', category: 'General', defaultKeys: 'ctrl+k | ctrl+shift+p' },
  { id: 'app.settings', title: 'Open Settings', category: 'Settings', defaultKeys: 'ctrl+,' },
  { id: 'app.bookmark', title: 'Toggle Bookmark on Current Page', category: 'General', defaultKeys: 'b' },
  { id: 'app.help', title: 'Show Keyboard Shortcuts', category: 'General', defaultKeys: '? | ctrl+/' },

  // Appended (ids are persisted — keep appending, never reorder).
  { id: 'view.fitHeight', title: 'Fit to Height', category: 'View', defaultKeys: 'ctrl+0' },
  { id: 'view.actualSize', title: 'Actual Size (100%)', category: 'View', defaultKeys: 'ctrl+1' },
  { id: 'app.escape', title: 'Close Toolbar / Exit Mode', category: 'General', defaultKeys: 'esc' },
  { id: 'annot.clearAll', title: 'Erase All Annotations', category: 'Annotation', defaultKeys: 'ctrl+shift+del' },
  { id: 'annot.clearPage', title: 'Erase Annotations on This Page', category: 'Annotation', defaultKeys: 'shift+del' },
  { id: 'annot.clearView', title: 'Erase Annotations in View', category: 'Annotation', defaultKeys: '' },
  { id: 'nav.back', title: 'Back (after following a link)', category: 'Navigation', defaultKeys: 'alt+left' },
  { id: 'nav.forward', title: 'Forward', category: 'Navigation', defaultKeys: 'alt+right' },
];

export const DEFAULT_SETTINGS: AppSettings = {
  meta: { schemaVersion: SCHEMA_VERSION, storageMode: 'local' },
  general: { rememberLastPage: true, restoreZoom: true, confirmOnExport: true, telemetry: false },
  viewing: {
    layoutMode: 'continuous',
    fitMode: 'width',
    smoothScroll: true,
    defaultZoom: 1,
    defaultRotation: 0,
    presentationMode: false,
    sidebar: { visible: true, activeTab: 'thumbnails', width: 240 },
  },
  search: { highlightAll: true, caseSensitive: false, regex: false, wholeWords: false },
  darkMode: {
    enabled: false,
    mode: 'smart-invert',
    smartImageProtection: true,
    brightness: 1,
    contrast: 0.6,
    activePresetId: 'soft-night',
    presets: DEFAULT_PRESETS,
  },
  annotation: {
    enabled: true,
    defaultTool: 'none',
    highlightColor: '#ffe066',
    highlightOpacity: 0.4,
    penColor: '#ff5252',
    penWidth: 2,
    shapeColor: '#4dabf7',
    // Ink is black on paper / white on a dark page; the pen is green in dark
    // mode so handwriting stands out from the (light grey) text.
    colors: {
      light: { highlight: '#ffe066', mark: '#000000', pen: '#000000', shape: '#000000', text: '#000000', note: '#ffe066' },
      dark: { highlight: '#ffe066', mark: '#ffffff', pen: '#4ade80', shape: '#ffffff', text: '#ffffff', note: '#ffe066' },
    },
    textStyle: { family: 'sans', size: 14 },
    autosave: true,
    middleClickEraser: { enabled: true, global: false, radius: 12, eraseWholeStroke: true },
  },
  tts: {
    enabled: true,
    engine: 'kokoro',
    voice: 'af_bella',
    speed: 1,
    pitch: 1,
    highlightGranularity: 'word',
    highlightWhileReading: true,
    preloadModelOnStart: false,
    fallbackToNativeWhileLoading: true,
    sentencePauseMs: 120,
    preferWebGPU: true,
    skipNonProse: true,
    device: 'auto',
    readingMode: 'clean',
    lookahead: '2',
  },
  ui: {
    theme: 'system',
    toolbarVisible: true,
    toolbarPosition: 'floating',
    density: 'comfortable',
    showStatusBar: true,
    distractionFree: false,
  },
  commandPalette: { enabled: true, fuzzy: true, recentCount: 8 },
  shortcuts: {
    enabled: true,
    vimEnabled: true,
    leaderKey: ',',
    sequenceTimeoutMs: 700,
    ignoreWhenTypingInInputs: true,
    keymap: {},
  },
};
