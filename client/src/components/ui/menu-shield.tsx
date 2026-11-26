import * as React from "react"
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu"

// Menus are not modal: a modal menu turns the whole page's pointer events off as it opens and back on as it
// closes, and the browser restyles every element on the page each time (about 100 ms on a sheet of 10,000 rows, on
// the click). The shield keeps what modal gave, at the cost of one element: a see-through layer over the page,
// under the menu, while it is open. A click or a tap outside the menu lands on it, so it closes the menu and does
// nothing else (the grid under it doesn't select, open or sort); the wheel and a finger's drag don't scroll the
// page behind it; and focus goes back to the menu's button, as it does after Escape. Tab on an entry closes the
// menu the same way (Radix keeps Tab inside a menu); in a menu's fields (the column filter, a search box) Tab moves
// between them and stops at the first and the last, as a modal menu kept focus in.
// The shield is a plain element of the page, not one React renders: React passes a portal's events up the tree
// it is rendered in, so a shield rendered by the menu handed a tap's click to the menu's React parents (on a
// phone, a tap on a dashboard row's ⋯ opened that table). Its events go only where the page's own go, up to
// <body> and the document, where the menu closes on a press or a tap outside.

type MenuState = {
  // Set when a press on the shield closes the menu: the menu then gives focus back to its button.
  pressed: React.MutableRefObject<boolean>
  close: () => void
  // Keeps the shield just under the menu's content (its own element in <body>), so the menu stays over it.
  under: (content: HTMLElement) => void
}
const MenuContext = React.createContext<MenuState | null>(null)

const stopDefault = (e: Event) => e.preventDefault()
const TABBABLE = 'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), '
  + 'a[href], [tabindex]:not([tabindex="-1"])'
const inField = (el: Element) => !!el.closest("[data-menu-field]") || el.matches("input, textarea, select")

// A press on the shield closes the menu itself: Radix starts listening for presses outside a menu only a moment
// after it opens (a timer), so on a busy page it can miss a press made right away.
function newShield(pressed: React.MutableRefObject<boolean>, close: () => void): HTMLDivElement {
  const el = document.createElement("div")
  el.setAttribute("data-menu-shield", "")
  el.setAttribute("aria-hidden", "true")
  el.className = "fixed inset-0 z-50"
  el.addEventListener("pointerdown", e => { pressed.current = true; e.preventDefault(); close() })
  el.addEventListener("mousedown", stopDefault)
  el.addEventListener("contextmenu", stopDefault)
  // Not passive, so they can stop a scroll.
  el.addEventListener("wheel", stopDefault, { passive: false })
  el.addEventListener("touchmove", stopDefault, { passive: false })
  return el
}

// DropdownMenu: never modal, with the shield while it is open. A `modal` prop is accepted and ignored.
export function MenuRoot({
  open, defaultOpen, onOpenChange, children, modal: _modal, ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Root> & { modal?: false }) {
  const [own, setOwn] = React.useState(defaultOpen ?? false)
  const shown = open ?? own
  const pressed = React.useRef(false)
  const shield = React.useRef<HTMLDivElement | null>(null)
  // The latest close, for the shield made when the menu opened.
  const closeRef = React.useRef(() => {})
  // In <body> before the menu's content: React runs a parent's layout effects after its children's, and the
  // content's portal comes in a render later (and `under` keeps the order otherwise).
  React.useLayoutEffect(() => {
    if (!shown) return
    pressed.current = false
    const el = newShield(pressed, () => closeRef.current())
    document.body.appendChild(el)
    shield.current = el
    return () => { el.remove(); shield.current = null }
  }, [shown])
  // Whether the menu is open as far as its owner was told: the shield's close and then Radix's own, for one press,
  // tell it once.
  const told = React.useRef(shown)
  told.current = shown
  const change = React.useCallback((next: boolean) => {
    if (told.current === next) return
    told.current = next
    setOwn(next)
    onOpenChange?.(next)
  }, [onOpenChange])
  closeRef.current = () => change(false)
  const state = React.useMemo<MenuState>(() => ({
    pressed,
    close: () => change(false),
    under: content => {
      const el = shield.current
      if (!el) return
      let top: HTMLElement = content
      while (top.parentElement && top.parentElement !== document.body) top = top.parentElement
      // The content came first in <body>: the shield goes just before it.
      const contentFirst = (el.compareDocumentPosition(top) & Node.DOCUMENT_POSITION_PRECEDING) !== 0
      if (contentFirst && top.parentElement === document.body) top.before(el)
    },
  }), [change])
  return (
    <MenuContext.Provider value={state}>
      <DropdownMenuPrimitive.Root {...props} modal={false} open={shown} onOpenChange={change}>
        {children}
      </DropdownMenuPrimitive.Root>
    </MenuContext.Provider>
  )
}

// For DropdownMenuContent, around the menu's own handlers: a close by the shield, or by Tab, puts focus on the
// button that opened the menu (found by aria-controls while it is open, and kept). An Escape Radix didn't handle closes
// it too (onKeyDown).
export function useMenuContent(
  ref: React.ForwardedRef<HTMLDivElement>,
  own: { onCloseAutoFocus?: (e: Event) => void; onKeyDown?: React.KeyboardEventHandler<HTMLDivElement> },
) {
  const menu = React.useContext(MenuContext)
  const trigger = React.useRef<HTMLElement | null>(null)
  const contentRef = React.useCallback((el: HTMLDivElement | null) => {
    const found = el?.id ? document.querySelector<HTMLElement>(`[aria-controls="${CSS.escape(el.id)}"]`) : null
    if (found) trigger.current = found
    if (el) menu?.under(el)
    if (typeof ref === "function") ref(el)
    else if (ref) ref.current = el
  }, [ref, menu])
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
    // An Escape nothing handled closes the menu. Radix closes it on Escape from a listener on the document, and marks
    // the key as handled when it does; but it works out whether the menu is the top layer when the menu renders, and
    // a menu just opened renders before it counts itself, so it drops the Escape pressed in that moment: on a busy
    // page, or Enter then Escape at once (radix-ui/primitives PR #4270, not released; dismissable-layer 1.1.11).
    if (e.key === "Escape" && !e.defaultPrevented && menu) {
      e.preventDefault()
      menu.close()
      return
    }
    if (e.defaultPrevented || !tab(e) || !menu || (e.target instanceof Element && inField(e.target))) return
    e.preventDefault()
    menu.close()
  }
  return { ref: contentRef, onCloseAutoFocus, onKeyDownCapture, onKeyDown }
}
