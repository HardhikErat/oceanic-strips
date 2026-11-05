#include "WsClient.h"

#include <vector>

#pragma comment(lib, "winhttp.lib")

static std::wstring Widen(const std::string& s) {
  if (s.empty()) return {};
  int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()), nullptr, 0);
  std::wstring w(n, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()), &w[0], n);
  return w;
}

void WsClient::Start(const std::string& url) {
  Stop();
  // parse ws[s]://host[:port]/path
  std::string u = url;
  secure_ = u.rfind("wss://", 0) == 0;
  size_t p = u.find("://");
  std::string rest = p == std::string::npos ? u : u.substr(p + 3);
  size_t slash = rest.find('/');
  std::string hostport = slash == std::string::npos ? rest : rest.substr(0, slash);
  std::string path = slash == std::string::npos ? "/plugin" : rest.substr(slash);
  size_t colon = hostport.find(':');
  std::string host = colon == std::string::npos ? hostport : hostport.substr(0, colon);
  port_ = static_cast<INTERNET_PORT>(colon == std::string::npos ? (secure_ ? 443 : 80) : atoi(hostport.substr(colon + 1).c_str()));
  host_ = Widen(host);
  path_ = Widen(path);
  running_ = true;
  worker_ = std::thread(&WsClient::Run, this);
}

void WsClient::Stop() {
  running_ = false;
  cv_.notify_all();
  Close();
  if (worker_.joinable()) worker_.join();
}

void WsClient::Send(const std::string& text) {
  {
    std::lock_guard<std::mutex> l(mu_);
    if (out_.size() > 200) out_.pop_front();  // drop oldest if the server is unreachable
    out_.push_back(text);
  }
  cv_.notify_all();
}

bool WsClient::Pop(std::string& out) {
  std::lock_guard<std::mutex> l(mu_);
  if (in_.empty()) return false;
  out = std::move(in_.front());
  in_.pop_front();
  return true;
}

void WsClient::Close() {
  std::lock_guard<std::mutex> l(sendMu_);
  if (socket_) {
    WinHttpWebSocketClose(socket_, WINHTTP_WEB_SOCKET_SUCCESS_CLOSE_STATUS, nullptr, 0);
    WinHttpCloseHandle(socket_);
    socket_ = nullptr;
  }
  if (request_) { WinHttpCloseHandle(request_); request_ = nullptr; }
  if (connection_) { WinHttpCloseHandle(connection_); connection_ = nullptr; }
  if (session_) { WinHttpCloseHandle(session_); session_ = nullptr; }
  connected_ = false;
}

bool WsClient::Connect() {
  session_ = WinHttpOpen(L"IndianOceanicStrips/0.1", WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
  if (!session_) { SetError("WinHttpOpen failed"); return false; }
  connection_ = WinHttpConnect(session_, host_.c_str(), port_, 0);
  if (!connection_) { SetError("WinHttpConnect failed"); return false; }
  request_ = WinHttpOpenRequest(connection_, L"GET", path_.c_str(), nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, secure_ ? WINHTTP_FLAG_SECURE : 0);
  if (!request_) { SetError("WinHttpOpenRequest failed"); return false; }
  if (!WinHttpSetOption(request_, WINHTTP_OPTION_UPGRADE_TO_WEB_SOCKET, nullptr, 0)) { SetError("upgrade option failed"); return false; }
  if (!WinHttpSendRequest(request_, WINHTTP_NO_ADDITIONAL_HEADERS, 0, nullptr, 0, 0, 0)) { SetError("server not reachable"); return false; }
  if (!WinHttpReceiveResponse(request_, nullptr)) { SetError("no response"); return false; }
  socket_ = WinHttpWebSocketCompleteUpgrade(request_, 0);
  if (!socket_) { SetError("websocket upgrade refused"); return false; }
  WinHttpCloseHandle(request_);
  request_ = nullptr;
  connected_ = true;
  SetError("");
  return true;
}

void WsClient::ReaderLoop() {
  std::vector<char> buf(64 * 1024);
  std::string msg;
  while (running_ && connected_) {
    DWORD read = 0;
    WINHTTP_WEB_SOCKET_BUFFER_TYPE type;
    DWORD err = WinHttpWebSocketReceive(socket_, buf.data(), static_cast<DWORD>(buf.size()), &read, &type);
    if (err != ERROR_SUCCESS || type == WINHTTP_WEB_SOCKET_CLOSE_BUFFER_TYPE) {
      connected_ = false;
      break;
    }
    msg.append(buf.data(), read);
    if (type == WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE || type == WINHTTP_WEB_SOCKET_BINARY_MESSAGE_BUFFER_TYPE) {
      std::lock_guard<std::mutex> l(mu_);
      if (in_.size() > 500) in_.pop_front();
      in_.push_back(std::move(msg));
      msg.clear();
    }
  }
  cv_.notify_all();
}

void WsClient::Run() {
  while (running_) {
    if (!Connect()) {
      Close();
      for (int i = 0; i < 50 && running_; i++) std::this_thread::sleep_for(std::chrono::milliseconds(100));
      continue;
    }
    std::string hello;
    {
      std::lock_guard<std::mutex> l(mu_);
      hello = hello_;
    }
    if (!hello.empty()) {
      std::lock_guard<std::mutex> l(sendMu_);
      WinHttpWebSocketSend(socket_, WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE, (PVOID)hello.data(), static_cast<DWORD>(hello.size()));
    }
    std::thread reader(&WsClient::ReaderLoop, this);
    while (running_ && connected_) {
      std::string next;
      {
        std::unique_lock<std::mutex> l(mu_);
        cv_.wait_for(l, std::chrono::milliseconds(250), [&] { return !out_.empty() || !running_ || !connected_; });
        if (!out_.empty()) {
          next = std::move(out_.front());
          out_.pop_front();
        }
      }
      if (!next.empty()) {
        std::lock_guard<std::mutex> l(sendMu_);
        if (!socket_ || WinHttpWebSocketSend(socket_, WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE, (PVOID)next.data(), static_cast<DWORD>(next.size())) != ERROR_SUCCESS) {
          connected_ = false;
        }
      }
    }
    Close();
    if (reader.joinable()) reader.join();
    for (int i = 0; i < 30 && running_; i++) std::this_thread::sleep_for(std::chrono::milliseconds(100));
  }
}
