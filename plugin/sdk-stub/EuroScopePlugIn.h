// =====================================================================================
//  COMPILE-CHECK STUB ONLY – NOT THE EUROSCOPE SDK.
//
//  Declares the subset of the EuroScope plug-in API this plugin uses, so the sources can
//  be syntax/type-checked without the SDK. A real build MUST use the official
//  EuroScopePlugIn.h + EuroScopePlugInDll.lib from your EuroScope installation
//  (PlugInEnvironment folder) – see plugin/README.md. Nothing here is linked.
// =====================================================================================
#pragma once
#include <windows.h>

namespace EuroScopePlugIn {

const int COMPATIBILITY_CODE = 16;
const int TAG_COLOR_DEFAULT = 0;
const int TAG_COLOR_RGB_DEFINED = 1;

class CPosition {
 public:
  double m_Latitude;
  double m_Longitude;
};

class CController {
 public:
  bool IsValid() const;
  const char* GetCallsign() const;
};

class CFlightPlanData {
 public:
  const char* GetPlanType() const;
  const char* GetAircraftInfo() const;
  const char* GetAircraftFPType() const;
  char GetEngineType() const;
  int GetTrueAirspeed() const;
  const char* GetOrigin() const;
  const char* GetDestination() const;
  const char* GetAlternate() const;
  const char* GetRemarks() const;
  const char* GetRoute() const;
};

class CFlightPlanControllerAssignedData {
 public:
  const char* GetSquawk() const;
  int GetClearedAltitude() const;
  int GetAssignedMach() const;
  bool SetClearedAltitude(int altitude);
  bool SetAssignedMach(int mach);
  bool SetFlightStripAnnotation(int index, const char* annotation);
};

class CFlightPlanExtractedRoute {
 public:
  int GetPointsNumber() const;
  const char* GetPointName(int index) const;
  CPosition GetPointPosition(int index) const;
};

class CRadarTargetPositionData {
 public:
  CPosition GetPosition() const;
  int GetPressureAltitude() const;
  int GetReportedGS() const;
  int GetReportedHeading() const;
};

class CRadarTarget {
 public:
  bool IsValid() const;
  CRadarTargetPositionData GetPosition() const;
};

class CFlightPlan {
 public:
  bool IsValid() const;
  const char* GetCallsign() const;
  int GetFinalAltitude() const;
  CFlightPlanData GetFlightPlanData() const;
  CFlightPlanControllerAssignedData GetControllerAssignedData() const;
  CFlightPlanExtractedRoute GetExtractedRoute() const;
  CRadarTarget GetCorrelatedRadarTarget() const;
};

class CPlugIn {
 public:
  CPlugIn(int CompatibilityCode, const char* PlugInName, const char* PlugInVersion, const char* PlugInAuthor, const char* PlugInCopyright);
  virtual ~CPlugIn();
  CController ControllerMyself() const;
  CFlightPlan FlightPlanSelectFirst() const;
  CFlightPlan FlightPlanSelectNext(CFlightPlan current) const;
  CFlightPlan FlightPlanSelect(const char* callsign) const;
  CFlightPlan FlightPlanSelectASEL() const;
  void RegisterTagItemType(const char* typeName, int code);
  void RegisterTagItemFunction(const char* functionName, int code);
  void DisplayUserMessage(const char* handler, const char* sender, const char* message, bool showHandler, bool showUnread, bool showUnreadEvenIfBusy,
                          bool startFlashing, bool needConfirmation);
  const char* GetDataFromSettings(const char* variableName);
  void SaveDataToSettings(const char* variableName, const char* variableDescription, const char* variableValue);

  virtual void OnTimer(int Counter);
  virtual void OnGetTagItem(CFlightPlan FlightPlan, CRadarTarget RadarTarget, int ItemCode, int TagData, char sItemString[16], int* pColorCode, COLORREF* pRGB,
                            double* pFontSize);
  virtual void OnFunctionCall(int FunctionId, const char* sItemString, POINT Pt, RECT Area);
  virtual bool OnCompileCommand(const char* sCommandLine);
};

}  // namespace EuroScopePlugIn
