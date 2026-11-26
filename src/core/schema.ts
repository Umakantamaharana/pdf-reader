/**
 * schema.ts — Single source of truth for the settings model.
 *
 * Everything the extension does is described here: feature toggles, colors,
 * TTS config, UI state, and the canonical command registry (with default
 * keybindings). The SettingsManager deep-merges stored data over DEFAULT_SETTINGS,
 * so adding a new field here automatically back-fills existing users on upgrade.
 */

export const SCHEMA_VERSION = 1;

/** A keybinding is a chord ("ctrl+shift+k") or a Vim-style sequence ("g g"). */
export type KeyBinding = string;

export type LayoutMode = 'single' | 'two-page' | 'continuous';
export type FitMode = 'width' | 'page' | 'auto' | 'actual';
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

export const DEFAULT_PRESETS: ColorPreset[] = [
  { id: 'pure-black', name: 'Pure Black', background: '#000000', foreground: '#e8e8e8' },
  { id: 'dark-slate', name: 'Dark Slate', background: '#1e222a', foreground: '#d6dae0' },
  { id: 'warm-sepia', name: 'Warm Sepia', background: '#f4ecd8', foreground: '#4a3f2f' },
  { id: 'night-dim', name: 'Night Dim', background: '#0d1117', foreground: '#9da7b3' },
];

/**
 * Canonical command registry. Keep ids stable — they are persisted in keymaps
 * and recent-command history. Add new commands by appending here.
 */
export const COMMANDS: Command[] = [
  // Navigation
  { id: 'nav.nextPage', title: 'Next Page', category: 'Navigation', defaultKeys: 'j' },
  { id: 'nav.prevPage', title: 'Previous Page', category: 'Navigation', defaultKeys: 'k' },
  { id: 'nav.firstPage', title: 'Go to First Page', category: 'Navigation', defaultKeys: 'g g' },
  { id: 'nav.lastPage', title: 'Go to Last Page', category: 'Navigation', defaultKeys: 'shift+g' },
  { id: 'nav.gotoPage', title: 'Go to Page…', category: 'Navigation', defaultKeys: 'ctrl+g' },
  { id: 'nav.scrollDown', title: 'Scroll Down (half page)', category: 'Navigation', defaultKeys: 'd' },
  { id: 'nav.scrollUp', title: 'Scroll Up (half page)', category: 'Navigation', defaultKeys: 'u' },
  { id: 'nav.lineDown', title: 'Scroll Down (line)', category: 'Navigation', defaultKeys: 'down' },
  { id: 'nav.lineUp', title: 'Scroll Up (line)', category: 'Navigation', defaultKeys: 'up' },

  // View
  { id: 'view.zoomIn', title: 'Zoom In', category: 'View', defaultKeys: 'ctrl+=' },
  { id: 'view.zoomOut', title: 'Zoom Out', category: 'View', defaultKeys: 'ctrl+-' },
  { id: 'view.fitWidth', title: 'Fit to Width', category: 'View', defaultKeys: 'shift+w' },
  { id: 'view.fitPage', title: 'Fit to Page', category: 'View', defaultKeys: 'shift+f' },
  { id: 'view.rotateCW', title: 'Rotate Clockwise', category: 'View', defaultKeys: 'r' },
  { id: 'view.rotateCCW', title: 'Rotate Counter-Clockwise', category: 'View', defaultKeys: 'shift+r' },
  { id: 'view.cycleLayout', title: 'Cycle Layout (Single/Two/Continuous)', category: 'View', defaultKeys: 'l' },
  { id: 'view.presentation', title: 'Toggle Presentation Mode', category: 'View', defaultKeys: 'f5' },
  { id: 'view.toggleSidebar', title: 'Toggle Sidebar', category: 'View', defaultKeys: 's' },
  { id: 'view.toggleToolbar', title: 'Toggle Toolbar', category: 'View', defaultKeys: 't' },
  { id: 'view.distractionFree', title: 'Toggle Distraction-Free Mode', category: 'View', defaultKeys: 'z z' },

  // Dark Mode
  { id: 'dark.toggle', title: 'Toggle Dark / Invert', category: 'Dark Mode', defaultKeys: 'shift+i' },
  { id: 'dark.panel', title: 'Open Display / Color Panel', category: 'Dark Mode', defaultKeys: 'shift+d' },
  { id: 'dark.cyclePreset', title: 'Cycle Color Preset', category: 'Dark Mode', defaultKeys: 'shift+p' },
  { id: 'dark.brightnessUp', title: 'Increase Brightness', category: 'Dark Mode', defaultKeys: 'shift+=' },
  { id: 'dark.brightnessDown', title: 'Decrease Brightness', category: 'Dark Mode', defaultKeys: 'shift+-' },

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
  { id: 'annot.redo', title: 'Redo', category: 'Annotation', defaultKeys: 'ctrl+shift+z' },
  { id: 'annot.export', title: 'Export Annotated PDF', category: 'Annotation', defaultKeys: 'ctrl+s' },

  // TTS
  { id: 'tts.playPause', title: 'Play / Pause Reading', category: 'TTS', defaultKeys: 'space' },
  { id: 'tts.stop', title: 'Stop Reading', category: 'TTS', defaultKeys: 'shift+space' },
  { id: 'tts.nextSentence', title: 'Next Sentence', category: 'TTS', defaultKeys: 'ctrl+right' },
  { id: 'tts.prevSentence', title: 'Previous Sentence', category: 'TTS', defaultKeys: 'ctrl+left' },
  { id: 'tts.speedUp', title: 'Speak Faster', category: 'TTS', defaultKeys: ']' },
  { id: 'tts.speedDown', title: 'Speak Slower', category: 'TTS', defaultKeys: '[' },
  { id: 'tts.readFromCursor', title: 'Read From Selection / Cursor', category: 'TTS', defaultKeys: 'shift+enter' },

  // Search
  { id: 'search.open', title: 'Find in Document', category: 'Search', defaultKeys: 'ctrl+f' },
  { id: 'search.openSlash', title: 'Find (Vim)', category: 'Search', defaultKeys: '/' },
  { id: 'search.next', title: 'Next Match', category: 'Search', defaultKeys: 'ctrl+n' },
  { id: 'search.prev', title: 'Previous Match', category: 'Search', defaultKeys: 'ctrl+shift+n' },

  // Settings / General
  { id: 'app.commandPalette', title: 'Open Command Palette', category: 'General', defaultKeys: 'ctrl+k' },
  { id: 'app.settings', title: 'Open Settings', category: 'Settings', defaultKeys: 'ctrl+,' },
  { id: 'app.bookmark', title: 'Toggle Bookmark on Current Page', category: 'General', defaultKeys: 'b' },
  { id: 'app.help', title: 'Show Keyboard Shortcuts', category: 'General', defaultKeys: '?' },
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
    contrast: 1,
    activePresetId: 'dark-slate',
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
