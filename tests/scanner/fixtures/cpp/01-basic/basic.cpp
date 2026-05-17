// CPP-1 fixture: namespaces, classes/structs with access modifiers,
// inheritance, member fields with pointer/reference depth, includes,
// macros, enum class, typedef.
#include <cstdint>
#include "engine.hpp"

#define MAX_NODES 1024

namespace engine {

enum class Severity {
  Low,
  Medium,
  High,
};

struct Vec3 {
  float x;
  float y;
  float z;
};

class Shape {
 public:
  Shape();
  virtual ~Shape();
  virtual float area() const = 0;

 protected:
  Vec3 origin;

 private:
  int id_;
};

class Circle : public Shape {
 public:
  Circle(float r);
  float area() const override;

 private:
  float radius_;
  Shape* next_;
  Shape& parent_ref_;
};

namespace inner {

class Widget : protected Shape, public Circle {
 public:
  Widget();

 private:
  const Vec3* origin_ptr_;
  int** double_ptr_;
};

}  // namespace inner

}  // namespace engine
