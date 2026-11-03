import toast from 'react-hot-toast'

// Cubex was updated while this tab stayed open (lib/build-watch.ts): one notice
// that stays until it's answered. Reloading is the person's call, never automatic:
// a dialog's unsaved text would go with it. Cell edits waiting to be saved are
// kept across the reload (hooks/sheet/pendingEditsStash.ts), and the browser
// asks first while any are (hooks/sheet/useCellOps.ts).
export function showUpdateNotice(): void {
  toast(t => (
    <span className="flex items-center gap-3 text-sm">
      <span>Cubex was updated. Reload to use the new version.</span>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="rounded-md bg-white px-2.5 py-1 font-medium text-[#252626] hover:bg-gray-100"
      >
        Reload
      </button>
      <button type="button" onClick={() => toast.dismiss(t.id)} className="text-gray-300 hover:text-white">
        Later
      </button>
    </span>
  ), { id: 'cubex-updated', duration: Infinity })
}
