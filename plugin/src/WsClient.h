// WebSocket client on WinHTTP (built into Windows 8+), running on its own threads so
// EuroScope's UI thread never blocks on the network.
#pragma once
#include <windows.h>
#include <winhttp.h>

#include <atomic>
#include <condition_variable>
#include <deque>
#include <mutex>
#include <string>
#include <thread>

class WsClient {
 public:
  WsClient() = default;
  ~WsClient() { Stop(); }

  /** url: ws://host:port/path or wss://host:port/path */
  void Start(const std::string& url);
  void Stop();
  void Send(const std::string& text);
  bool Pop(std::string& out);
  bool Connected() const { return connected_; }
  std::string LastError() {
    std::lock_guard<std::mutex> l(mu_);
    return lastError_;
  }

  /** set by the owner: first message sent after every (re)connect */
  void SetHello(const std::string& hello) {
    std::lock_guard<std::mutex> l(mu_);
    hello_ = hello;
  }

 private:
  void Run();
  bool Connect();
  void ReaderLoop();
  void Close();
  void SetError(const std::string& e) {
    std::lock_guard<std::mutex> l(mu_);
    lastError_ = e;
  }

  std::wstring host_, path_;
  INTERNET_PORT port_ = 8787;
  bool secure_ = false;

  HINTERNET session_ = nullptr, connection_ = nullptr, request_ = nullptr, socket_ = nullptr;
  std::thread worker_;
  std::atomic<bool> running_{false};
  std::atomic<bool> connected_{false};
  std::mutex mu_;
  std::mutex sendMu_;
  std::condition_variable cv_;
  std::deque<std::string> out_;
  std::deque<std::string> in_;
  std::string hello_;
  std::string lastError_;
};
