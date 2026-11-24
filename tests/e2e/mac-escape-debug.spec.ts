import { test, expect, type Page } from '@playwright/test'
import { authedApi, seedSheet, BASE } from './helpers'
import { openDataMenu } from './helpers-ui'

// Test branch only: logs every Escape on the page (where it lands, what has focus, who stops or prevents it) and
// what the page holds then, through the sheet-toolbar sequence that fails on a Mac.

async function instrument(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __esc: string[] }
    w.__esc = []
    const log = (m: string) => w.__esc.push(`${performance.now().toFixed(0)} ${m}`)
    const desc = (el: unknown) => {
      if (el === window) return 'WINDOW'
      if (el === document) return 'DOCUMENT'
      const e = el as Element | null
      if (!e || !e.tagName) return String(el)
      return `${e.tagName}${e.id ? '#' + e.id : ''}[role=${e.getAttribute('role')}][testid=${e.getAttribute('data-testid')}]`
    }
    const page_ = () => `menus=${document.querySelectorAll('[role=menu]').length} dialogs=${
      document.querySelectorAll('[role=dialog]').length} shields=${document.querySelectorAll('[data-menu-shield]').length
    } poppers=${document.querySelectorAll('[data-radix-popper-content-wrapper]').length} focusVisible=${
      document.activeElement?.matches(':focus-visible')} hasFocus=${document.hasFocus()}`
    for (const name of ['preventDefault', 'stopPropagation', 'stopImmediatePropagation'] as const) {
      const real = Event.prototype[name]
      Event.prototype[name] = function (this: Event) {
        const k = this as KeyboardEvent
        if ((k.type === 'keydown' || k.type === 'keyup') && k.key === 'Escape') {
          const stack = (new Error().stack ?? '').split('\n').slice(2, 5).map(s => s.trim()).join(' | ')
          log(`${k.type} ${name} at ${desc(this.currentTarget)} phase ${this.eventPhase} :: ${stack}`)
        }
        return real.call(this)
      }
    }
    for (const type of ['keydown', 'keyup']) {
      window.addEventListener(type, e => {
        const k = e as KeyboardEvent
        if (k.key !== 'Escape') return
        log(`${type} capture@window target ${desc(k.target)} active ${desc(document.activeElement)} trusted ${
          k.isTrusted} code ${k.code} keyCode ${k.keyCode} meta ${k.metaKey} :: ${page_()}`)
      }, true)
      window.addEventListener(type, e => {
        const k = e as KeyboardEvent
        if (k.key === 'Escape') log(`${type} bubble@window defaultPrevented ${k.defaultPrevented}`)
      })
    }
    // Radix keeps its layers (menus, popovers) in a Set of elements: every element added to or deleted from a Set.
    const sizes = new WeakMap<Set<unknown>, number>()
    let ids = 0
    const setId = new WeakMap<Set<unknown>, number>()
    const idOf = (s: Set<unknown>) => { if (!setId.has(s)) setId.set(s, ++ids); return setId.get(s) }
    const add = Set.prototype.add, del = Set.prototype.delete
    Set.prototype.add = function (this: Set<unknown>, v: unknown) {
      const out = add.call(this, v)
      if (v instanceof Element) log(`set#${idOf(this)}.add ${desc(v)} size ${this.size} connected ${v.isConnected}`)
      return out
    }
    Set.prototype.delete = function (this: Set<unknown>, v: unknown) {
      const out = del.call(this, v)
      if (v instanceof Element) log(`set#${idOf(this)}.delete ${desc(v)} -> ${out} size ${this.size}`)
      return out
    }
    void sizes
    document.addEventListener('dismissableLayer.update', () => log('dismissableLayer.update'))
    new MutationObserver(list => {
      for (const m of list) {
        for (const n of m.addedNodes) if (n instanceof Element && n.querySelector?.('[role=menu]')) log(`menu added`)
        for (const n of m.removedNodes) if (n instanceof Element && n.querySelector?.('[role=menu]')) log(`menu removed`)
      }
    }).observe(document.documentElement, { childList: true, subtree: true })
    let moves = 0
    window.addEventListener('pointermove', () => { moves++ }, true)
    window.addEventListener('keydown', e => { if ((e as KeyboardEvent).key === 'Escape') log(`pointermoves so far ${moves}`) },
      true)
    document.addEventListener('focusin', e => log(`focusin ${desc(e.target)}`), true)
    document.addEventListener('focusout', e => log(`focusout ${desc(e.target)} -> ${desc((e as FocusEvent).relatedTarget)}`),
      true)
    window.addEventListener('blur', () => log('window blur'))
    window.addEventListener('focus', () => log('window focus'))
  })
}

const dump = async (page: Page, label: string) => {
  const lines = await page.evaluate(() => {
    const w = window as unknown as { __esc: string[] }
    const out = w.__esc.slice()
    w.__esc.length = 0
    return out
  })
  console.log(`---- ${label}\n${lines.join('\n')}`)
}

test('mac escape debug: Escape on the Data menu after a drawer closed with Escape', async ({ page, context }) => {
  test.setTimeout(120_000)
  const api = await authedApi()
  const { tableId } = await seedSheet(api, 3)
  await context.addCookies((await api.storageState()).cookies)
  await instrument(page)
  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })
  console.log('userAgent', await page.evaluate(() => `${navigator.userAgent} platform=${navigator.platform}`))

  // Plain: the menu with nothing before it.
  await page.getByTestId('data-menu').click()
  await expect(page.getByRole('menu')).toBeFocused()
  await page.keyboard.press('Escape')
  const plain = await expect(page.getByRole('menu')).toHaveCount(0, { timeout: 2_000 }).then(() => true, () => false)
  await dump(page, `plain menu: closed=${plain}`)
  if (!plain) await page.mouse.click(5, 5)

  for (let round = 1; round <= 3; round++) {
    await openDataMenu(page, 'Webhook')
    const webhook = page.getByRole('heading', { name: 'Webhook', exact: true })
    await expect(webhook).toBeVisible()
    await page.waitForFunction(() => document.getAnimations().length === 0)
    await page.keyboard.press('Escape')
    await expect(webhook).toBeHidden()
    await dump(page, `round ${round}: drawer closed with Escape`)

    await page.getByTestId('data-menu').click()
    await expect(page.getByRole('menuitem', { name: /^Import CSV/ })).toBeVisible()
    await expect(page.getByRole('menu')).toBeFocused()
    if (round === 2) {
      await page.evaluate(() => document.dispatchEvent(new CustomEvent('dismissableLayer.update')))
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0))))
    }
    await page.keyboard.press('Escape')
    const closed = await expect(page.getByRole('menu')).toHaveCount(0, { timeout: 2_000 }).then(() => true, () => false)
    await dump(page, `round ${round}: menu Escape (keyboard.press): closed=${closed}`)
    if (closed) continue

    // A second real press.
    await page.keyboard.press('Escape')
    const second = await expect(page.getByRole('menu')).toHaveCount(0, { timeout: 2_000 }).then(() => true, () => false)
    await dump(page, `round ${round}: second keyboard.press: closed=${second}`)
    if (second) continue

    // A keydown made in the page.
    await page.evaluate(() => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true,
    } as KeyboardEventInit)))
    const synthetic = await expect(page.getByRole('menu')).toHaveCount(0, { timeout: 2_000 })
      .then(() => true, () => false)
    await dump(page, `round ${round}: dispatched keydown: closed=${synthetic}`)
    if (!synthetic) await page.mouse.click(5, 5)
  }
  await api.dispose()
})
