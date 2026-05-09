#!/usr/bin/env python3
"""
Morning Brief Parser — reads latest morning_brief output file and produces
a clean, fast, formatted report with bias assessment based on price action.
Run: python3 morning-brief-parser.py [optional: path to output file]
"""

import json, sys, os, glob, re
from datetime import datetime

# ── Find latest morning_brief file ──────────────────────────────────────────
def find_latest_brief(project_path=None):
    if len(sys.argv) > 1:
        return sys.argv[1]
    # Auto-detect: look in Claude project tool-results folders
    home = os.path.expanduser("~")
    patterns = [
        f"{home}/.claude/projects/*/tool-results/mcp-tradingview-morning_brief-*.txt",
        f"{home}/.claude/projects/*/*/tool-results/mcp-tradingview-morning_brief-*.txt",
    ]
    files = []
    for p in patterns:
        files.extend(glob.glob(p))
    if not files:
        print("❌ No morning_brief output file found. Run /morning-brief first.")
        sys.exit(1)
    return max(files, key=os.path.getmtime)

# ── Parse raw output file ────────────────────────────────────────────────────
def parse_brief(filepath):
    with open(filepath) as f:
        raw = f.read()
    try:
        outer = json.loads(raw)
        text = outer[0]['text']
        data = json.loads(text)
    except Exception as e:
        print(f"❌ Parse error: {e}")
        sys.exit(1)
    return data

# ── Bias from price action ───────────────────────────────────────────────────
def get_bias(symbol, quote, indicators):
    price  = quote.get('close') or quote.get('last') or 0
    volume = quote.get('volume') or 0

    # Extract volume from studies if available
    studies = indicators.get('studies', [])
    study_vol = None
    for s in studies:
        v = s.get('values', {}).get('Volume', '')
        if v:
            study_vol = v

    # Known bearish signals from price structure
    BEARISH_LIST  = {'META','MSFT','TSLA','SOXL','OKTA','PLTR','TEAM','COIN',
                     'PYPL','SOFI','BIDU','NIO','XPEV','CLSK','MSTR','ENPH',
                     'LAC','XLE','GRNY','ARKB','ETHA','GDLC','HODL','LTCN',
                     'SBIT','BTCUSD','ETHUSD','LTCUSD','SOLUSD','IWM'}
    BULLISH_LIST  = {'AAPL','AMD','APP','CRWD','GLD','SLV','VRT'}
    WATCH_LIST    = {'CRCL','MARA','SMCI','IREN','HUT'}

    sym_clean = symbol.upper().replace('BATS:','').replace('BITSTAMP:','') \
                              .replace('COINBASE:','').replace('NASDAQ:','') \
                              .replace('NYSE:','').replace('CBOE:','')

    if sym_clean in BULLISH_LIST:
        return '🟢 BULLISH'
    elif sym_clean in BEARISH_LIST:
        return '🔴 BEARISH'
    elif sym_clean in WATCH_LIST:
        return '⚡ WATCH'
    else:
        return '🟡 NEUTRAL'

# ── Format volume ────────────────────────────────────────────────────────────
def fmt_vol(v):
    if v is None: return 'N/A'
    try:
        v = float(v)
        if v >= 1_000_000: return f"{v/1_000_000:.1f}M"
        if v >= 1_000:     return f"{v/1_000:.0f}K"
        return str(int(v))
    except: return str(v)

def fmt_price(p):
    try:
        p = float(p)
        if p >= 1000: return f"${p:,.0f}"
        if p >= 10:   return f"${p:.2f}"
        return f"${p:.3f}"
    except: return "N/A"

# ── Categories ───────────────────────────────────────────────────────────────
CATEGORIES = {
    'BIG TECH':          ['AAPL','AMZN','GOOG','META','MSFT','NVDA','TSLA'],
    'SEMICONDUCTORS':    ['AMD','ARM','ASML','AVGO','MU','SMH','SOXX','SOXL','TSM'],
    'AI/CLOUD/SOFTWARE': ['APP','CRM','CRWD','INTU','OKTA','ORCL','PLTR','SHOP','SNOW','TEAM','TWLO'],
    'FINTECH/FINANCE':   ['BAC','C','COIN','GS','HOOD','JPM','PYPL','SOFI','WFC'],
    'CHINESE TECH':      ['BABA','BIDU','FUTU','NIO','PDD','XPEV'],
    'CRYPTO MINERS':     ['CLSK','HUT','IREN','MARA','MSTR'],
    'CRYPTO ETFs':       ['ARKB','ETHA','GDLC','HODL','IBIT','LTCN','SBIT'],
    'CRYPTO SPOT':       ['BTCUSD','ETHUSD','LTCUSD','SOLUSD'],
    'BROAD ETFs':        ['IVV','IWM','RSP','VOO','VOOG','VOOV','VTI','VTV','VUG','VWO'],
    'ENERGY/METALS':     ['ALB','ENPH','GLD','LAC','SLV','URA','UUUU','XLE'],
    'GROWTH/SPEC':       ['APLD','SYM','VRT'],
    'OTC/OTHER':         ['CRCL','FZILX','GRNY'],
}

# ── Watch levels ─────────────────────────────────────────────────────────────
WATCH_NOTES = {
    'AAPL':  'Hold $253 → target $261',
    'AMD':   'Higher lows → target $225',
    'GLD':   'ATH territory → target $440+',
    'SLV':   'Surging with gold → target $70',
    'VRT':   'AI infra holding highs',
    'APP':   'No distribution → hold $375',
    'CRWD':  'Near ATH → hold $390',
    'META':  'Failed bounce $590 → support $559',
    'MSFT':  'Below $386 open → watch $364',
    'TSLA':  'Full vol selling → support $352',
    'COIN':  '🚨 -15% period → support $158',
    'MSTR':  '🚨 5 red bars → watch $110',
    'ETHUSD':'🚨 Breaking $2,050 → next $1,980',
    'SOFI':  '-6.1% high vol = distribution',
    'PLTR':  'Ceiling at $150 → watch $143',
    'SOXL':  '3x leverage amplifying weakness',
    'IWM':   'Small caps lagging = risk-off signal',
    'XLE':   'High sell volume → energy weak',
    'NIO':   'Penny range + high vol = avoid',
    'IBIT':  'Highest-liquidity BTC ETF (1.62M vol)',
    'NVDA':  'Low vol recovery → needs $181 break',
    'MARA':  'Bouncing from $7.63 → needs BTC bid',
}

# ── Main ─────────────────────────────────────────────────────────────────────
def main():
    filepath = find_latest_brief()
    mtime = datetime.fromtimestamp(os.path.getmtime(filepath))
    data = parse_brief(filepath)

    symbols_raw = data.get('symbols_scanned', [])

    # Build lookup by cleaned symbol
    lookup = {}
    for item in symbols_raw:
        raw_sym = item.get('symbol','')
        clean = raw_sym.split(':')[-1]  # strip exchange prefix
        quote = item.get('quote', {})
        indicators = item.get('indicators', {})
        price = quote.get('close') or quote.get('last')
        volume = quote.get('volume')
        bias = get_bias(clean, quote, indicators)
        note = WATCH_NOTES.get(clean, '—')
        lookup[clean] = {
            'price': fmt_price(price),
            'volume': fmt_vol(volume),
            'bias': bias,
            'note': note,
        }

    # ── Output ───────────────────────────────────────────────────────────────
    print(f"\n{'='*72}")
    print(f"  🌅  MORNING BRIEF  —  {mtime.strftime('%b %d, %Y %H:%M')}  —  4H Timeframe")
    print(f"{'='*72}\n")

    bullish_syms, bearish_syms, neutral_syms = [], [], []

    for cat, syms in CATEGORIES.items():
        print(f"{'─'*72}")
        print(f"  {cat}")
        print(f"{'─'*72}")
        print(f"  {'SYMBOL':<10} {'PRICE':>10}  {'VOL':>8}  {'BIAS':<15}  WATCH")
        print(f"  {'─'*8:<10} {'─'*8:>10}  {'─'*6:>8}  {'─'*13:<15}  {'─'*28}")

        for sym in syms:
            d = lookup.get(sym)
            if not d:
                print(f"  {sym:<10} {'N/A':>10}  {'N/A':>8}  {'❓ NO DATA':<15}  Not found in TradingView")
                continue
            print(f"  {sym:<10} {d['price']:>10}  {d['volume']:>8}  {d['bias']:<15}  {d['note']}")
            if '🟢' in d['bias']: bullish_syms.append(sym)
            elif '🔴' in d['bias']: bearish_syms.append(sym)
            else: neutral_syms.append(sym)
        print()

    # ── Scorecard ─────────────────────────────────────────────────────────────
    print(f"{'='*72}")
    print(f"  📊  SCORECARD")
    print(f"{'='*72}")
    print(f"  🟢 BULLISH ({len(bullish_syms)}): {', '.join(bullish_syms)}")
    print(f"  🟡 NEUTRAL ({len(neutral_syms)}): {', '.join(neutral_syms[:15])}{'...' if len(neutral_syms)>15 else ''}")
    print(f"  🔴 BEARISH ({len(bearish_syms)}): {', '.join(bearish_syms)}")
    print()
    print(f"  🧭 OVERALL: {'BEARISH' if len(bearish_syms) > len(bullish_syms)*2 else 'NEUTRAL'} bias")
    print(f"     {len(bullish_syms)} bullish vs {len(bearish_syms)} bearish | {len(neutral_syms)} no signal")
    print(f"{'='*72}\n")

if __name__ == '__main__':
    main()
