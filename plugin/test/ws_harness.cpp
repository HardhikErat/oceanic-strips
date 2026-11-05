// Network test for the plugin's WebSocket client and JSON code, without EuroScope.
// Connects to the strip server like the DLL does, sends one flight, prints what comes back.
//   ws_harness.exe ws://127.0.0.1:8787/plugin <token> <seconds>
#include <chrono>
#include <cstdio>
#include <thread>

#include "Json.h"
#include "WsClient.h"

int main(int argc, char** argv) {
  std::string url = argc > 1 ? argv[1] : "ws://127.0.0.1:8787/plugin";
  std::string token = argc > 2 ? argv[2] : "change-me";
  int seconds = argc > 3 ? atoi(argv[3]) : 12;
  WsClient ws;
  ws.SetHello(json::Obj().Add("type", json::Str("hello")).Add("token", json::Str(token)).Add("callsign", json::Str("VABF_OC_CTR")).Add("version", json::Str("harness")).Done());
  ws.Start(url);
  auto flight = json::Obj()
                    .Add("callsign", json::Str("TST401"))
                    .Add("aircraft", json::Str("B789/H-SDE1E2E3FGHIJ2J3J4J5M1RWXYZ/LB1D1"))
                    .Add("type", json::Str("B789"))
                    .Add("rules", json::Str("I"))
                    .Add("adep", json::Str("OTHH"))
                    .Add("ades", json::Str("VRMM"))
                    .Add("altn", json::Str("VOTV"))
                    .Add("route", json::Str("N0485F330 GOLNI P570 KITAL L894 BIBGO"))
                    .Add("rfl", json::Int(33000))
                    .Add("tas", json::Int(485))
                    .Add("remarks", json::Str("PBN/A1B1C1D1L1 SEL/ABCD"))
                    .Add("squawk", json::Str("2177"))
                    .Add("engine", json::Str("J"))
                    .Add("clearedFl", json::Int(330))
                    .Add("mach", json::Num(0.84))
                    .Done();
  std::string msg = json::Obj().Add("type", json::Str("flights")).Add("flights", "[" + flight + "]").Done();
  bool wasConnected = false;
  for (int t = 0; t < seconds * 10; t++) {
    if (ws.Connected() != wasConnected) {
      wasConnected = ws.Connected();
      printf("[%4.1fs] %s %s\n", t / 10.0, wasConnected ? "CONNECTED" : "DISCONNECTED", ws.LastError().c_str());
    }
    if (wasConnected && t % 30 == 5) ws.Send(msg);
    std::string in;
    while (ws.Pop(in)) {
      auto v = json::Parse(in);
      std::string type = v->Text("type");
      if (type == "tags") {
        const json::Value* tg = v->Get("tags");
        const json::Value* x = tg ? tg->Get("TST401") : nullptr;
        if (x) printf("[%4.1fs] tags TST401: next=%s eto=%s cat=%s level=%.0f\n", t / 10.0, x->Text("next").c_str(), x->Text("eto").c_str(), x->Text("cat").c_str(), x->NumberOr("level", 0));
        else printf("[%4.1fs] tags (no TST401 yet)\n", t / 10.0);
      } else {
        printf("[%4.1fs] %s\n", t / 10.0, in.substr(0, 160).c_str());
      }
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
  }
  ws.Stop();
  printf("done\n");
  return 0;
}
