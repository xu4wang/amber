# 天气：当前天气 + 未来 24 小时气温折线图（vega-lite）
# 输入：stdin JSON {"params": {"city": "..."}, "caller": {"city": "..."}}
import json, re, sys, urllib.parse, urllib.request
WMO = {
    0: "晴", 1: "大致晴朗", 2: "局部多云", 3: "阴",
    45: "雾", 48: "冻雾",
    51: "小毛毛雨", 53: "毛毛雨", 55: "大毛毛雨",
    56: "小冻毛毛雨", 57: "冻毛毛雨",
    61: "小雨", 63: "中雨", 65: "大雨",
    66: "小冻雨", 67: "冻雨",
    71: "小雪", 73: "中雪", 75: "大雪", 77: "米雪",
    80: "小阵雨", 81: "阵雨", 82: "强阵雨",
    85: "小阵雪", 86: "阵雪",
    95: "雷暴", 96: "雷暴伴小冰雹", 99: "雷暴伴冰雹",
}

def http_json(url):
    with urllib.request.urlopen(url, timeout=12) as r:
        return json.loads(r.read().decode("utf-8"))


def md(s):
    return re.sub(r"([*_`|\\\[\]<>])", r"\\\1", str(s))


inp = json.load(sys.stdin)
city = (inp.get("params", {}).get("city") or inp.get("caller", {}).get("city") or "曼谷").strip()
if not re.match(r"^[一-鿿A-Za-z .-]{1,64}$", city):
    print("城市名只能包含中英文字母和空格。")
    sys.exit(0)
lang = "zh" if re.search(r"[一-鿿]", city) else "en"
geo = [r for r in (http_json("https://geocoding-api.open-meteo.com/v1/search?name=" + urllib.parse.quote(city) + "&count=5&language=" + lang).get("results") or []) if "latitude" in r]
if not geo:
    print("没有找到城市「{}」，换个写法再试（例如：北京、Bangkok）。".format(md(city)))
    sys.exit(0)
exact = [r for r in geo if str(r.get("name", "")).casefold() == city.casefold()]
g = max(exact, key=lambda x: x.get("population") or 0) if exact else geo[0]
place = "，".join([p for p in (g.get("name"), g.get("admin1"), g.get("country")) if p])
fc = http_json("https://api.open-meteo.com/v1/forecast?latitude={:.4f}&longitude={:.4f}"
               "&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m"
               "&hourly=temperature_2m&forecast_hours=24&timezone=auto".format(g["latitude"], g["longitude"]))
cur, unit = fc.get("current") or {}, fc.get("current_units") or {}
v = lambda k, u: "—" if cur.get(k) is None else "{}{}".format(cur.get(k), unit.get(k, u))
print("**{} 当前天气**\n".format(md(place)))
print("- 天气：{}".format(WMO.get(cur.get("weather_code"), "未知")))
print("- 气温：{}\n- 体感：{}\n- 湿度：{}\n- 风速：{}".format(v("temperature_2m", "°C"), v("apparent_temperature", "°C"), v("relative_humidity_2m", "%"), v("wind_speed_10m", "km/h")))
print("\n观测时间：{}（{}）\n".format(str(cur.get("time", "—")).replace("T", " "), fc.get("timezone", "")))
h = fc.get("hourly") or {}
values = [{"时间": t[5:16].replace("T", " "), "气温℃": x} for t, x in zip(h.get("time") or [], h.get("temperature_2m") or []) if x is not None]
spec = {"title": "未来 24 小时气温（℃）", "data": {"values": values}, "mark": "line",
        "encoding": {"x": {"field": "时间", "type": "ordinal"}, "y": {"field": "气温℃", "type": "quantitative"}}}
print("```vega-lite\n" + json.dumps(spec, ensure_ascii=False) + "\n```")
