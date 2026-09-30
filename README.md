# WOBD: Web On-Board Diagnostics

A free, browser-based car diagnostic tool. Plug a USB OBD-II adapter into a Chromebook or laptop, open the site, and read your car's trouble codes with nothing to install. Bob, a scripted cartoon mechanic, explains each code in plain English.

> **Status:** in active testing and development. Results aren't guaranteed yet.

## What you need

- An OBD-II car (US model year 1996 and newer)
- A USB ELM327-compatible adapter
- Chrome, Edge, or Opera on desktop, or Chrome on ChromeOS (Web Serial is required)

## Run it locally

WOBD is a static site with no build step. Serve the folder over localhost, which Web Serial treats as secure:

```sh
python3 -m http.server 8000
```

Then open http://localhost:8000 in Chrome or Edge.

### Demo mode

Try the whole flow without a car or adapter:

| URL | Pretend car |
| --- | --- |
| `/?demo` | CAN car with codes P0301, P0171, P0442 |
| `/?demo=iso` | Older ISO 9141 car (like a 2001 PT Cruiser) with P0420 and P1491, no VIN |
| `/?demo=clear` | No trouble codes |

## Project layout

| Path | What it is |
| --- | --- |
| `index.html`, `guide.html` | The app and the How to use page |
| `css/` | Theme and layout (`style.css`), print report (`print.css`) |
| `js/serial.js`, `js/elm327.js`, `js/obd.js` | Web Serial, the ELM327 command queue, OBD-II decoding |
| `js/bob.js`, `js/voice.js` | Bob's explanations and optional read-aloud voice |
| `js/ui.js`, `js/app.js` | Rendering and app wiring |
| `js/demo.js` | Pretend adapter for demo mode |
| `data/codes.json` | Bob's code book |

## Contributing code explanations

Each entry in `data/codes.json` needs a `title`, a plain-English `plain` line under 40 words, an `urgency` (`low`, `medium`, or `high`), a few `causes` (cheapest first), a `difficulty` (`diy`, `moderate`, or `shop`), and a `tellMechanic` line. Write explanations in your own words.

## License

GPL v3. See [LICENSE](LICENSE).

WOBD gives general information, not a professional diagnosis. Always confirm a problem before replacing parts.
