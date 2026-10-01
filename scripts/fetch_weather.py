"""天気予報を取得して data/ に保存する（毎日 23:00 JST に実行する想定）。

- data/latest.json            最新の予報（今日から16日分）
- data/history/YYYY-MM.json   日ごとの記録。翌日分は実行のたびに上書き（＝前夜確定版）、
                              当日分はまだ無いときだけ書く
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
JST = timezone(timedelta(hours=9))
API = "https://api.open-meteo.com/v1/forecast"
HOURLY = "weather_code,temperature_2m,apparent_temperature,precipitation_probability,precipitation,wind_speed_10m"
DAILY = "weather_code,temperature_2m_max,temperature_2m_min,uv_index_max"
RETRIES = 3
RETRY_WAIT = int(os.environ.get("RETRY_WAIT", "600"))


def fetch(loc):
    query = urllib.parse.urlencode({
        "latitude": loc["lat"],
        "longitude": loc["lon"],
        "hourly": HOURLY,
        "daily": DAILY,
        "timezone": "Asia/Tokyo",
        "forecast_days": 16,
        "wind_speed_unit": "ms",
    })
    with urllib.request.urlopen(f"{API}?{query}", timeout=30) as res:
        data = json.load(res)
    return {"hourly": data["hourly"], "daily": data["daily"]}


def fetch_all(locations):
    for attempt in range(1, RETRIES + 1):
        try:
            return [{**loc, **fetch(loc)} for loc in locations]
        except Exception as e:
            print(f"取得失敗 ({attempt}/{RETRIES}): {e}", file=sys.stderr)
            if attempt == RETRIES:
                raise
            time.sleep(RETRY_WAIT)


def slice_day(loc, date):
    """1地点の予報から date の分だけを、元と同じ形で切り出す。"""
    hourly, daily = loc["hourly"], loc["daily"]
    hi = [i for i, t in enumerate(hourly["time"]) if t.startswith(date)]
    di = [i for i, t in enumerate(daily["time"]) if t == date]
    return {
        "name": loc["name"], "lat": loc["lat"], "lon": loc["lon"],
        "hourly": {k: [v[i] for i in hi] for k, v in hourly.items()},
        "daily": {k: [v[i] for i in di] for k, v in daily.items()},
    }


def save_history(locations, now):
    today = now.strftime("%Y-%m-%d")
    tomorrow = (now + timedelta(days=1)).strftime("%Y-%m-%d")
    for date, overwrite in ((today, False), (tomorrow, True)):
        path = ROOT / "data" / "history" / f"{date[:7]}.json"
        month = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        if date in month and not overwrite:
            continue
        month[date] = {
            "fetched": now.isoformat(timespec="seconds"),
            "locations": [slice_day(loc, date) for loc in locations],
        }
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(dict(sorted(month.items())), ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def main():
    config = json.loads((ROOT / "config" / "locations.json").read_text(encoding="utf-8"))
    locations = fetch_all(config)
    now = datetime.now(JST)
    latest = {"updated": now.isoformat(timespec="seconds"), "locations": locations}
    out = ROOT / "data" / "latest.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(latest, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    save_history(locations, now)
    print(f"更新: {latest['updated']} / {', '.join(loc['name'] for loc in locations)}")


if __name__ == "__main__":
    main()
