import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** @type {import('tailwindcss').Config} */
export default {
    darkMode: ["class"],
    content: [
    path.join(__dirname, 'index.html'),
    path.join(__dirname, 'src/**/*.{js,ts,jsx,tsx}'),
  ],
  theme: {
  	extend: {
  		colors: {
  			border: 'hsl(var(--border))',
  			input: 'hsl(var(--input))',
  			ring: 'hsl(var(--ring))',
  			background: 'hsl(var(--background))',
  			foreground: 'hsl(var(--foreground))',
  			// Monochrome primary scale. Originally teal (#1FA8D6 etc.) which
  				// leaked the old brand color into 'text-primary-600' link styling
  				// on auth pages even after the cube-* palette was unified. Now
  				// every step is a grey shade so primary-* utilities resolve to
  				// the same logo-grounded story as the rest of the UI.
  			primary: {
  				'50':  '#f8f8f8',
  				'100': '#eeeeee',
  				'200': '#dcdcdc',
  				'300': '#bdbdbd',
  				'400': '#9e9e9e',
  				'500': '#626364', // matches cube-grey
  				'600': '#4a4b4b',
  				'700': '#363737',
  				'800': '#2a2a2a',
  				'900': '#252626', // matches cube-black
  				DEFAULT: 'hsl(var(--primary))',
  				foreground: 'hsl(var(--primary-foreground))'
  			},
  			// Same monochrome treatment for the secondary scale (was orange
  				// #FF5C33). Kept around because shadcn/ui components reference
  				// secondary.DEFAULT / secondary.foreground via CSS vars and we
  				// don't want to break those. Numeric steps are now greys.
  			secondary: {
  				'50':  '#f8f8f8',
  				'100': '#eeeeee',
  				'200': '#dcdcdc',
  				'300': '#bdbdbd',
  				'400': '#9e9e9e',
  				'500': '#626364',
  				'600': '#4a4b4b',
  				'700': '#363737',
  				'800': '#2a2a2a',
  				'900': '#252626',
  				DEFAULT: 'hsl(var(--secondary))',
  				foreground: 'hsl(var(--secondary-foreground))'
  			},
  			destructive: {
  				DEFAULT: 'hsl(var(--destructive))',
  				foreground: 'hsl(var(--destructive-foreground))'
  			},
  			muted: {
  				DEFAULT: 'hsl(var(--muted))',
  				foreground: 'hsl(var(--muted-foreground))'
  			},
  			accent: {
  				DEFAULT: 'hsl(var(--accent))',
  				foreground: 'hsl(var(--accent-foreground))'
  			},
  			popover: {
  				DEFAULT: 'hsl(var(--popover))',
  				foreground: 'hsl(var(--popover-foreground))'
  			},
  			card: {
  				DEFAULT: 'hsl(var(--card))',
  				foreground: 'hsl(var(--card-foreground))'
  			},
  			// Logo-grounded monochrome palette. Sourced directly from the
  				// colors of the cube logo (client/public/cubex.svg):
  				//   white = top face + background
  				//   black = dark left face
  				//   grey  = medium right face
  				// The earlier teal/orange/golden/charcoal colors were dropped
  				// because they didn't appear in the logo and barely showed in
  				// the UI (one gradient bar on the dashboard).
  			cube: {
  				black:    '#252626',
  				grey:     '#626364',
  				white:    '#FFFFFF',
  			},
  			// warning / success / danger scales kept for backwards-compat but
  				// flattened to greyscale. The semantic meaning of these states
  				// in Cubex is now carried by Tailwind's built-in red-*, amber-*,
  				// green-* utilities at the actual usage sites (e.g. red-600 for
  				// error text). No utility in the codebase currently references
  				// these custom scales — dead weight if not for theme tooling.
  			warning: {
  				'50':  '#f8f8f8',
  				'100': '#eeeeee',
  				'200': '#dcdcdc',
  				'300': '#bdbdbd',
  				'400': '#9e9e9e',
  				'500': '#626364',
  				'600': '#4a4b4b',
  				'700': '#363737',
  				'800': '#2a2a2a',
  				'900': '#252626'
  			},
  			success: {
  				'50':  '#f8f8f8',
  				'100': '#eeeeee',
  				'200': '#dcdcdc',
  				'300': '#bdbdbd',
  				'400': '#9e9e9e',
  				'500': '#626364',
  				'600': '#4a4b4b',
  				'700': '#363737',
  				'800': '#2a2a2a',
  				'900': '#252626'
  			},
  			danger: {
  				'50':  '#f8f8f8',
  				'100': '#eeeeee',
  				'200': '#dcdcdc',
  				'300': '#bdbdbd',
  				'400': '#9e9e9e',
  				'500': '#626364',
  				'600': '#4a4b4b',
  				'700': '#363737',
  				'800': '#2a2a2a',
  				'900': '#252626'
  			},
  			chart: {
  				'1': 'hsl(var(--chart-1))',
  				'2': 'hsl(var(--chart-2))',
  				'3': 'hsl(var(--chart-3))',
  				'4': 'hsl(var(--chart-4))',
  				'5': 'hsl(var(--chart-5))'
  			}
  		},
  		fontFamily: {
  			sans: [
  				'Inter',
  				'system-ui',
  				'sans-serif'
  			],
  			mono: [
  				'JetBrains Mono',
  				'Menlo',
  				'Monaco',
  				'monospace'
  			],
  			brand: [
  				'Poppins',
  				'system-ui',
  				'sans-serif'
  			]
  		},
  		borderRadius: {
  			lg: 'var(--radius)',
  			md: 'calc(var(--radius) - 2px)',
  			sm: 'calc(var(--radius) - 4px)'
  		}
  	}
  },
  plugins: [require("tailwindcss-animate")],
}
