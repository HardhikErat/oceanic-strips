// Indian Oceanic Strips – EuroScope plugin.
//
// Streams flight plans (with EuroScope-resolved route points from the loaded VABF/VOMF
// sector file), correlated positions and controller-assigned data to the strip server,
// and applies level/Mach amendments made on the web board. Adds tag items for the next
// fix/estimate, ADS-B/procedural category, conflict partner and overdue report.
#include "OceanicStrips.h"

#include <shellapi.h>

#include <cmath>
#include <sstream>

#include "Json.h"

using namespace EuroScopePlugIn;

namespace {
const char* kName = "Indian Oceanic Strips";
const char* kVersion = "0.1.0";
const char* kAuthor = "VATSIM India vACC community";
const char* kCopyright = "VATSIM use only";

enum TagItems {
  TAG_NEXT_ETO = 1,
  TAG_CATEGORY = 2,
  TAG_CONFLICT = 3,
  TAG_REPORT_DUE = 4,
  TAG_MACH = 5,
};
enum TagFunctions {
  FN_OPEN_BOARD = 1,
};

// Only flights that can touch Indian oceanic airspace are sent.
bool InRegion(double lat, double lon) { return lat > -45 && lat < 42 && lon > 28 && lon < 118; }

std::string Upper(std::string s) {
  for (auto& c : s) c = static_cast<char>(toupper(static_cast<unsigned char>(c)));
  return s;
}
}  // namespace

COceanicStrips::COceanicStrips() : CPlugIn(COMPATIBILITY_CODE, kName, kVersion, kAuthor, kCopyright) {
  RegisterTagItemType("Oceanic: next fix / estimate", TAG_NEXT_ETO);
  RegisterTagItemType("Oceanic: ADS-B / procedural", TAG_CATEGORY);
  RegisterTagItemType("Oceanic: conflict partner", TAG_CONFLICT);
  RegisterTagItemType("Oceanic: report overdue", TAG_REPORT_DUE);
  RegisterTagItemType("Oceanic: Mach", TAG_MACH);
  RegisterTagItemFunction("Oceanic: open strip board", FN_OPEN_BOARD);

  url_ = Setting("url", "ws://127.0.0.1:8787/plugin");
  token_ = Setting("token", "change-me");
  boardUrl_ = Setting("board", "http://127.0.0.1:8787/");
  Msg(std::string("Loaded. Server ") + url_ + "  (commands: .oceanic url|token|board|connect|status)");
  Connect();
}

COceanicStrips::~COceanicStrips() { ws_.Stop(); }

std::string COceanicStrips::Setting(const char* key, const char* def) {
  const char* v = GetDataFromSettings(key);
  return v && *v ? std::string(v) : std::string(def);
}

void COceanicStrips::Msg(const std::string& text) {
  DisplayUserMessage("Oceanic Strips", "Oceanic", text.c_str(), true, false, false, false, false);
}

void COceanicStrips::Connect() {
  CController me = ControllerMyself();
  std::string callsign = me.IsValid() ? me.GetCallsign() : "";
  ws_.SetHello(json::Obj()
                   .Add("type", json::Str("hello"))
                   .Add("token", json::Str(token_))
                   .Add("callsign", json::Str(callsign))
                   .Add("version", json::Str(kVersion))
                   .Done());
  ws_.Start(url_);
}

void COceanicStrips::OnTimer(int Counter) {
  // inbound first (amendments / tag data)
  std::string in;
  int n = 0;
  while (n++ < 50 && ws_.Pop(in)) HandleMessage(in);

  bool c = ws_.Connected();
  if (c != wasConnected_) {
    Msg(c ? "Connected to strip server" : "Disconnected from strip server – retrying (" + ws_.LastError() + ")");
    wasConnected_ = c;
  }
  if (c && Counter % 5 == 0) SendFlights();
}

void COceanicStrips::SendFlights() {
  std::ostringstream arr;
  arr << '[';
  bool first = true;
  for (CFlightPlan fp = FlightPlanSelectFirst(); fp.IsValid(); fp = FlightPlanSelectNext(fp)) {
    CFlightPlanData d = fp.GetFlightPlanData();
    if (std::string(d.GetPlanType()) != "I") continue;
    CFlightPlanExtractedRoute r = fp.GetExtractedRoute();
    int np = r.GetPointsNumber();
    if (np < 2) continue;
    bool relevant = false;
    for (int i = 0; i < np && !relevant; i++) {
      CPosition p = r.GetPointPosition(i);
      relevant = InRegion(p.m_Latitude, p.m_Longitude);
    }
    if (!relevant) continue;

    std::ostringstream pts;
    pts << '[';
    for (int i = 0; i < np; i++) {
      CPosition p = r.GetPointPosition(i);
      if (i) pts << ',';
      pts << json::Obj()
                 .Add("name", json::Str(r.GetPointName(i)))
                 .Add("lat", json::Num(p.m_Latitude))
                 .Add("lon", json::Num(p.m_Longitude))
                 .Done();
    }
    pts << ']';

    CFlightPlanControllerAssignedData ad = fp.GetControllerAssignedData();
    json::Obj o;
    o.Add("callsign", json::Str(fp.GetCallsign()))
        .Add("aircraft", json::Str(d.GetAircraftInfo()))
        .Add("type", json::Str(d.GetAircraftFPType()))
        .Add("rules", json::Str(d.GetPlanType()))
        .Add("adep", json::Str(d.GetOrigin()))
        .Add("ades", json::Str(d.GetDestination()))
        .Add("altn", json::Str(d.GetAlternate()))
        .Add("route", json::Str(d.GetRoute()))
        .Add("rfl", json::Int(fp.GetFinalAltitude()))
        .Add("tas", json::Int(d.GetTrueAirspeed()))
        .Add("remarks", json::Str(d.GetRemarks()))
        .Add("squawk", json::Str(ad.GetSquawk()))
        .Add("engine", json::Str(std::string(1, d.GetEngineType())))
        .Add("points", pts.str());
    int cleared = ad.GetClearedAltitude();
    if (cleared > 2) o.Add("clearedFl", json::Int((cleared + 50) / 100));
    int mach = ad.GetAssignedMach();
    if (mach > 0) o.Add("mach", json::Num(mach / 100.0));

    CRadarTarget rt = fp.GetCorrelatedRadarTarget();
    if (rt.IsValid()) {
      CRadarTargetPositionData pos = rt.GetPosition();
      CPosition p = pos.GetPosition();
      o.Add("pos", json::Obj()
                       .Add("lat", json::Num(p.m_Latitude))
                       .Add("lon", json::Num(p.m_Longitude))
                       .Add("alt", json::Int(pos.GetPressureAltitude()))
                       .Add("gs", json::Int(pos.GetReportedGS()))
                       .Add("hdg", json::Int(pos.GetReportedHeading()))
                       .Done());
    }
    if (!first) arr << ',';
    first = false;
    arr << o.Done();
  }
  arr << ']';
  ws_.Send(json::Obj().Add("type", json::Str("flights")).Add("flights", arr.str()).Done());
}

void COceanicStrips::HandleMessage(const std::string& text) {
  auto v = json::Parse(text);
  if (!v || v->type != json::Value::Object) return;
  std::string type = v->Text("type");
  if (type == "welcome") {
    Msg("Server accepted plugin" + (v->Text("unit").empty() ? std::string(" (no oceanic unit for this callsign)") : " for " + v->Text("unit")));
  } else if (type == "error") {
    std::string m = v->Text("message");
    if (m.find("token") != std::string::npos) {
      // do not hammer the server with a wrong token; wait for ".oceanic token <token>"
      ws_.Stop();
      wasConnected_ = false;
      Msg("Server rejected the plugin token. Set it with: .oceanic token <token>");
    } else {
      Msg("Server: " + m);
    }
  } else if (type == "amend") {
    std::string cs = v->Text("callsign");
    CFlightPlan fp = FlightPlanSelect(cs.c_str());
    if (!fp.IsValid()) return;
    CFlightPlanControllerAssignedData ad = fp.GetControllerAssignedData();
    if (v->Has("clearedFl")) {
      int fl = static_cast<int>(v->NumberOr("clearedFl", 0));
      if (fl > 0 && !ad.SetClearedAltitude(fl * 100)) Msg(cs + ": cannot set cleared level (not tracked by you?)");
    }
    if (v->Has("mach")) {
      int m = static_cast<int>(std::lround(v->NumberOr("mach", 0) * 100));
      if (m > 0) ad.SetAssignedMach(m);
    }
    if (v->Has("annotation")) {
      // annotation slot 8 holds the last position report ("KITAL 0053")
      ad.SetFlightStripAnnotation(8, v->Text("annotation").c_str());
    }
  } else if (type == "tags") {
    const json::Value* t = v->Get("tags");
    if (!t || t->type != json::Value::Object) return;
    tags_.clear();
    for (const auto& kv : t->o) {
      const json::Value& x = *kv.second;
      TagInfo ti;
      ti.next = x.Text("next");
      ti.eto = x.Text("eto");
      ti.cat = x.Text("cat");
      ti.level = static_cast<int>(x.NumberOr("level", 0));
      ti.mach = x.NumberOr("mach", 0);
      const json::Value* due = x.Get("due");
      ti.due = due && due->type == json::Value::Bool && due->b;
      const json::Value* c = x.Get("conflict");
      if (c && c->type == json::Value::Object) {
        ti.conflictWith = c->Text("with");
        ti.conflictSeverity = c->Text("severity");
      }
      tags_[kv.first] = ti;
    }
  }
}

void COceanicStrips::OnGetTagItem(CFlightPlan FlightPlan, CRadarTarget, int ItemCode, int, char sItemString[16], int* pColorCode, COLORREF* pRGB, double*) {
  if (!FlightPlan.IsValid()) return;
  auto it = tags_.find(FlightPlan.GetCallsign());
  if (it == tags_.end()) return;
  const TagInfo& t = it->second;
  std::string out;
  switch (ItemCode) {
    case TAG_NEXT_ETO:
      if (!t.next.empty()) out = t.next + " " + t.eto;
      break;
    case TAG_CATEGORY:
      out = t.cat;
      break;
    case TAG_CONFLICT:
      if (!t.conflictWith.empty()) {
        out = (t.conflictSeverity == "LOS" ? "!" : "?") + t.conflictWith;
        *pColorCode = TAG_COLOR_RGB_DEFINED;
        *pRGB = t.conflictSeverity == "LOS" ? RGB(255, 60, 60) : t.conflictSeverity == "WARN" ? RGB(255, 176, 32) : RGB(180, 140, 255);
      }
      break;
    case TAG_REPORT_DUE:
      if (t.due) {
        out = "DUE";
        *pColorCode = TAG_COLOR_RGB_DEFINED;
        *pRGB = RGB(230, 40, 160);
      }
      break;
    case TAG_MACH:
      if (t.mach > 0) {
        char b[8];
        snprintf(b, sizeof b, "M%02d", static_cast<int>(std::lround(t.mach * 100)));
        out = b;
      }
      break;
  }
  strncpy_s(sItemString, 16, out.c_str(), _TRUNCATE);
}

void COceanicStrips::OnFunctionCall(int FunctionId, const char*, POINT, RECT) {
  if (FunctionId != FN_OPEN_BOARD) return;
  CFlightPlan fp = FlightPlanSelectASEL();
  std::string url = boardUrl_;
  if (fp.IsValid()) url += std::string(url.find('?') == std::string::npos ? "?" : "&") + "flight=" + fp.GetCallsign();
  ShellExecuteA(nullptr, "open", url.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
}

bool COceanicStrips::OnCompileCommand(const char* sCommandLine) {
  std::string line(sCommandLine);
  std::string up = Upper(line);
  if (up.rfind(".OCEANIC", 0) != 0) return false;
  std::istringstream is(line);
  std::string cmd, verb, arg;
  is >> cmd >> verb >> arg;
  verb = Upper(verb);
  if (verb == "URL" && !arg.empty()) {
    url_ = arg;
    SaveDataToSettings("url", "Oceanic strip server WebSocket URL", url_.c_str());
    Connect();
    Msg("Server URL set to " + url_);
  } else if (verb == "TOKEN" && !arg.empty()) {
    token_ = arg;
    SaveDataToSettings("token", "Oceanic strip server plugin token", token_.c_str());
    Connect();
    Msg("Token saved, reconnecting");
  } else if (verb == "BOARD" && !arg.empty()) {
    boardUrl_ = arg;
    SaveDataToSettings("board", "Oceanic strip board URL", boardUrl_.c_str());
    Msg("Board URL set to " + boardUrl_);
  } else if (verb == "CONNECT") {
    Connect();
    Msg("Reconnecting to " + url_);
  } else {
    Msg(std::string(ws_.Connected() ? "Connected" : "Not connected") + " to " + url_ + (ws_.LastError().empty() ? "" : " – " + ws_.LastError()));
  }
  return true;
}

// ---------------------------------------------------------------------------

static COceanicStrips* gPlugin = nullptr;

void __declspec(dllexport) EuroScopePlugInInit(EuroScopePlugIn::CPlugIn** ppPlugInInstance) {
  *ppPlugInInstance = gPlugin = new COceanicStrips();
}

void __declspec(dllexport) EuroScopePlugInExit(void) {
  delete gPlugin;
  gPlugin = nullptr;
}
