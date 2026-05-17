// CPP-4 fixture: template parameters and explicit specialisation.
//
// Covers:
//   - primary class template with a single type parameter
//   - multi-parameter template with type + non-type parameter and a
//     default value
//   - free function template
//   - explicit class-template specialisation

namespace engine {

template <typename T>
class Box {
public:
    T value;
    T get() const { return value; }
};

template <typename K, typename V, int N = 16>
struct Pair {
    K key;
    V value;
};

template <typename T>
T identity(T x) { return x; }

template <>
class Box<int> {
public:
    int value;
    int doubled() const { return value * 2; }
};

} // namespace engine
