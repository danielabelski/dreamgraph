/* DreamGraph wave-1 C-3 fixture: source defines what the header declared. */
#include "graph.h"

struct Node {
    int value;
    Node *next;
};

int node_count(const struct Bucket *bucket) {
    int n = 0;
    for (Node *it = bucket->first; it; it = it->next) ++n;
    return n;
}

Node *node_make(int value) {
    (void)value;
    return 0;
}
