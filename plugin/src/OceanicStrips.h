#pragma once
#include <windows.h>

#include <map>
#include <string>

#include "EuroScopePlugIn.h"
#include "WsClient.h"

struct TagInfo {
  std::string next, eto, cat, conflictWith, conflictSeverity, phase;
  int level = 0;
  double mach = 0;
  bool due = false;
};

class COceanicStrips : public EuroScopePlugIn::CPlugIn {
 public:
  COceanicStrips();
  ~COceanicStrips() override;

  void OnTimer(int Counter) override;
  void OnGetTagItem(EuroScopePlugIn::CFlightPlan FlightPlan, EuroScopePlugIn::CRadarTarget RadarTarget, int ItemCode, int TagData,
                    char sItemString[16], int* pColorCode, COLORREF* pRGB, double* pFontSize) override;
  void OnFunctionCall(int FunctionId, const char* sItemString, POINT Pt, RECT Area) override;
  bool OnCompileCommand(const char* sCommandLine) override;

 private:
  void Connect();
  void SendFlights();
  void HandleMessage(const std::string& text);
  void Msg(const std::string& text);
  std::string Setting(const char* key, const char* def);

  WsClient ws_;
  std::string url_, token_, boardUrl_;
  std::map<std::string, TagInfo> tags_;
  bool wasConnected_ = false;
};
