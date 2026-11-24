import * as React from "react"
import { createPortal } from "react-dom"
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu"

// Menus are not modal: a modal menu turns the whole page's pointer events off as it opens and back on as it
// closes, and the browser restyles every element on the page each time (about 100 ms on a sheet of 10,000 rows, on
// the click). The shield keeps what modal gave, at the cost of one element: a see-through layer over the page,
// under the menu, while it is open. A click or a tap outside the menu lands on it, so it closes the menu and does
// nothing else (the grid under it doesn't select, open or sort); the wheel and a finger's drag don't scroll the
// page behind it; and focus goes back to the menu's button, as it does after Escape. Tab on an entry closes the
// menu the same way (Radix keeps Tab inside a menu); in a menu's fields (the column filter, a search box) Tab moves
// between them and stops at the first and the last, as a modal menu kept focus in.

type MenuState = {
  // Set when a press on the shield closes the menu: the menu then gives focus back to its button.
  pressed: React.MutableRefObject<boolean>
  close: () => void
}
const MenuContext = React.createContext<MenuState | null>(null)

const stopScroll = (e: Event) => e.preventDefault()
const TABBABLE = 'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), '
  + 'a[href], [tabindex]:not([tabindex="-1"])'
const inField = (el: Element) => !!el.closest("[data-menu-field]") || el.matches("input, textarea, select")

function MenuShield({ pressed }: { pressed: React.MutableRefObject<boolean> }) {
  const ref = React.useCallback((el: HTMLDivElement | null) => {
    if (!el) return
    // React's wheel and touch listeners are passive and can't stop a scroll.
    el.addEventListener("wheel", stopScroll, { passive: false })
    el.addEventListener("touchmove", stopScroll, { passive: false })
  }, [])
  return createPortal(
    <div ref={ref} data-menu-shield aria-hidden="true" className="fixed inset-0 z-50"
      onPointerDown={e => { pressed.current = true; e.preventDefault() }}
      onMouseDown={e => e.preventDefault()}
      onContextMenu={e => e.preventDefault()} />,
    document.body,
  )
}

// DropdownMenu: never modal, with the shield while it is open. A `modal` prop is accepted and ignored.
export function MenuRoot({
  open, defaultOpen, onOpenChange, children, modal: _modal, ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Root> & { modal?: false }) {
  const [own, setOwn] = React.useState(defaultOpen ?? false)
  const shown = open ?? own
  const pressed = React.useRef(false)
  React.useEffect(() => { if (shown) pressed.current = false }, [shown])
  const change = React.useCallback((next: boolean) => { setOwn(next); onOpenChange?.(next) }, [onOpenChange])
  const state = React.useMemo(() => ({ pressed, close: () => change(false) }), [change])
  return (
    <MenuContext.Provider value={state}>
      <DropdownMenuPrimitive.Root {...props} modal={false} open={shown} onOpenChange={change}>
        {shown && <MenuShield pressed={pressed} />}
        {children}
      </DropdownMenuPrimitive.Root>
    </MenuContext.Provider>
  )
}

// For DropdownMenuContent, around the menu's own handlers: a close by the shield, or by Tab, puts focus on the
// button that opened the menu (found by aria-controls while it is open, and kept).
export function useMenuContent(
  ref: React.ForwardedRef<HTMLDivElement>,
  own: { onCloseAutoFocus?: (e: Event) => void; onKeyDown?: React.KeyboardEventHandler<HTMLDivElement> },
) {
  const menu = React.useContext(MenuContext)
  const trigger = React.useRef<HTMLElement | null>(null)
  const contentRef = React.useCallback((el: HTMLDivElement | null) => {
    const found = el?.id ? document.querySelector<HTMLElement>(`[aria-controls="${CSS.escape(el.id)}"]`) : null
    if (found) trigger.current = found
    if (typeof ref === "function") ref(el)
    else if (ref) ref.current = el
  }, [ref])
  const onCloseAutoFocus = (e: Event) => {
    own.onCloseAutoFocus?.(e)
    const byShield = !!menu?.pressed.current
    if (menu) menu.pressed.current = false
    if (e.defaultPrevented || !byShield) return
    e.preventDefault()
    trigger.current?.focus({ preventScroll: true })
  }
  const tab = (e: React.KeyboardEvent) => e.key === "Tab" && !e.altKey && !e.ctrlKey && !e.metaKey
  // A field's own key handler keeps its keys from the menu: Tab is seen here, before it, and stays in the menu.
  const onKeyDownCapture = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!tab(e) || !(e.target instanceof HTMLElement) || !inField(e.target)) return
    const stops = [...e.currentTarget.querySelectorAll<HTMLElement>(TABBABLE)].filter(el => el.offsetParent !== null)
    if (!stops[stops.indexOf(e.target) + (e.shiftKey ? -1 : 1)]) e.preventDefault()
  }
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    own.onKeyDown?.(e)
    if (e.defaultPrevented || !tab(e) || !menu || (e.target instanceof Element && inField(e.target))) return
    e.preventDefault()
    menu.close()
  }
  return { ref: contentRef, onCloseAutoFocus, onKeyDownCapture, onKeyDown }
}
