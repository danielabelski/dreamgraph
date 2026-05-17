// CPP-2 fixture: member methods, constructors, destructors,
// in-class inline definitions, and out-of-line member definitions.
#include "shapes.hpp"

namespace engine {

class Shape {
 public:
  Shape();
  Shape(int id);
  virtual ~Shape();
  virtual float area() const = 0;

  // Inline method definition.
  int id() const { return id_; }

 private:
  int id_;
};

class Circle : public Shape {
 public:
  Circle(float r);
  ~Circle();
  float area() const override;
  void scale(float k);

 private:
  float radius_;
};

}  // namespace engine

// ----- Out-of-line member definitions ----------------------------------

namespace engine {

Shape::Shape() : id_(0) {}

Shape::Shape(int id) : id_(id) {}

Shape::~Shape() {}

}  // namespace engine

// Fully qualified, outside any namespace block.
engine::Circle::Circle(float r) : radius_(r) {}

engine::Circle::~Circle() {}

float engine::Circle::area() const {
  return 3.14f * radius_ * radius_;
}

void engine::Circle::scale(float k) {
  radius_ *= k;
}

// A free function for contrast.
namespace engine {
void utility_free_function(int);  // declaration
void utility_free_function(int x) { (void)x; }
}
