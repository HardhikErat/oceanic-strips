// Minimal JSON writer + parser (enough for the plugin <-> server protocol).
#pragma once
#include <cstdio>
#include <cstdlib>
#include <map>
#include <memory>
#include <string>
#include <vector>

namespace json {

inline std::string Escape(const std::string& s) {
  std::string o;
  o.reserve(s.size() + 2);
  for (unsigned char c : s) {
    switch (c) {
      case '"': o += "\\\""; break;
      case '\\': o += "\\\\"; break;
      case '\n': o += "\\n"; break;
      case '\r': o += "\\r"; break;
      case '\t': o += "\\t"; break;
      default:
        if (c < 0x20) {
          char b[8];
          snprintf(b, sizeof b, "\\u%04x", c);
          o += b;
        } else {
          o += static_cast<char>(c);
        }
    }
  }
  return o;
}

inline std::string Str(const std::string& s) { return "\"" + Escape(s) + "\""; }
inline std::string Num(double v) {
  char b[32];
  snprintf(b, sizeof b, "%.6f", v);
  // trim trailing zeros
  std::string s(b);
  while (!s.empty() && s.back() == '0') s.pop_back();
  if (!s.empty() && s.back() == '.') s.pop_back();
  return s;
}
inline std::string Int(long long v) { return std::to_string(v); }

/** Builds {"k":v,...} incrementally. Values must already be JSON encoded. */
class Obj {
 public:
  Obj& Add(const char* k, const std::string& encoded) {
    if (!first_) s_ += ',';
    first_ = false;
    s_ += Str(k);
    s_ += ':';
    s_ += encoded;
    return *this;
  }
  std::string Done() const { return "{" + s_ + "}"; }

 private:
  std::string s_;
  bool first_ = true;
};

struct Value;
using ValuePtr = std::shared_ptr<Value>;

struct Value {
  enum Type { Null, Bool, Number, String, Array, Object } type = Null;
  bool b = false;
  double n = 0;
  std::string s;
  std::vector<ValuePtr> a;
  std::map<std::string, ValuePtr> o;

  const Value* Get(const std::string& k) const {
    if (type != Object) return nullptr;
    auto it = o.find(k);
    return it == o.end() ? nullptr : it->second.get();
  }
  std::string Text(const std::string& k, const std::string& def = "") const {
    const Value* v = Get(k);
    return v && v->type == String ? v->s : def;
  }
  double NumberOr(const std::string& k, double def) const {
    const Value* v = Get(k);
    return v && v->type == Number ? v->n : def;
  }
  bool Has(const std::string& k) const { return Get(k) != nullptr && Get(k)->type != Null; }
};

class Parser {
 public:
  explicit Parser(const std::string& s) : s_(s) {}
  ValuePtr Parse() {
    auto v = ParseValue();
    return v;
  }

 private:
  const std::string& s_;
  size_t i_ = 0;

  void Ws() {
    while (i_ < s_.size() && (s_[i_] == ' ' || s_[i_] == '\n' || s_[i_] == '\r' || s_[i_] == '\t')) i_++;
  }
  ValuePtr ParseValue() {
    Ws();
    auto v = std::make_shared<Value>();
    if (i_ >= s_.size()) return v;
    char c = s_[i_];
    if (c == '{') {
      v->type = Value::Object;
      i_++;
      Ws();
      if (i_ < s_.size() && s_[i_] == '}') { i_++; return v; }
      while (i_ < s_.size()) {
        Ws();
        std::string k = ParseString();
        Ws();
        if (i_ < s_.size() && s_[i_] == ':') i_++;
        v->o[k] = ParseValue();
        Ws();
        if (i_ < s_.size() && s_[i_] == ',') { i_++; continue; }
        if (i_ < s_.size() && s_[i_] == '}') { i_++; break; }
        break;
      }
    } else if (c == '[') {
      v->type = Value::Array;
      i_++;
      Ws();
      if (i_ < s_.size() && s_[i_] == ']') { i_++; return v; }
      while (i_ < s_.size()) {
        v->a.push_back(ParseValue());
        Ws();
        if (i_ < s_.size() && s_[i_] == ',') { i_++; continue; }
        if (i_ < s_.size() && s_[i_] == ']') { i_++; break; }
        break;
      }
    } else if (c == '"') {
      v->type = Value::String;
      v->s = ParseString();
    } else if (c == 't' || c == 'f') {
      v->type = Value::Bool;
      v->b = c == 't';
      i_ += v->b ? 4 : 5;
    } else if (c == 'n') {
      i_ += 4;
    } else {
      v->type = Value::Number;
      char* end = nullptr;
      v->n = strtod(s_.c_str() + i_, &end);
      i_ = end ? static_cast<size_t>(end - s_.c_str()) : i_ + 1;
    }
    return v;
  }
  std::string ParseString() {
    std::string o;
    if (i_ >= s_.size() || s_[i_] != '"') return o;
    i_++;
    while (i_ < s_.size() && s_[i_] != '"') {
      char c = s_[i_++];
      if (c == '\\' && i_ < s_.size()) {
        char e = s_[i_++];
        switch (e) {
          case 'n': o += '\n'; break;
          case 'r': o += '\r'; break;
          case 't': o += '\t'; break;
          case 'u': {
            if (i_ + 4 <= s_.size()) {
              unsigned cp = static_cast<unsigned>(strtoul(s_.substr(i_, 4).c_str(), nullptr, 16));
              i_ += 4;
              // UTF-8 encode (BMP only)
              if (cp < 0x80) o += static_cast<char>(cp);
              else if (cp < 0x800) { o += static_cast<char>(0xC0 | (cp >> 6)); o += static_cast<char>(0x80 | (cp & 0x3F)); }
              else { o += static_cast<char>(0xE0 | (cp >> 12)); o += static_cast<char>(0x80 | ((cp >> 6) & 0x3F)); o += static_cast<char>(0x80 | (cp & 0x3F)); }
            }
            break;
          }
          default: o += e;
        }
      } else {
        o += c;
      }
    }
    i_++;
    return o;
  }
};

inline ValuePtr Parse(const std::string& s) { return Parser(s).Parse(); }

}  // namespace json
