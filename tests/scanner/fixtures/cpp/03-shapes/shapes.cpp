// CPP-3 fixture: smart pointers and STL container shapes.
#include <memory>
#include <vector>
#include <list>
#include <set>
#include <unordered_map>

namespace engine {

struct Node {
  int payload;
};

struct Item {
  int id;
};

class Registry {
 public:
  Registry();
  ~Registry();

 private:
  // Smart pointers.
  std::unique_ptr<Node> root_;          // OWNS
  std::shared_ptr<Item> shared_item_;   // OWNS_SHARED
  std::weak_ptr<Item> weak_item_;       // BORROWS_WEAK

  // Bare-name smart pointer (assumes `using std::unique_ptr;`).
  unique_ptr<Node> alt_root_;           // OWNS

  // STL containers.
  std::vector<Item> items_;             // CONTAINS_MANY
  std::list<Node> nodes_;               // CONTAINS_MANY
  std::set<int> ids_;                   // CONTAINS_MANY (primitive target)

  // Associative containers.
  std::unordered_map<int, Item> by_id_; // MAPS_K_TO_V (value=Item)

  // Plain pointer (still POINTS_TO, unaffected by CPP-3).
  Node* raw_;
};

}  // namespace engine
