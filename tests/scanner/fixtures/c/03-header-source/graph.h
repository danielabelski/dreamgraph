/* DreamGraph wave-1 C-3 fixture: header declares, source defines. */
#ifndef GRAPH_03_HEADER_H
#define GRAPH_03_HEADER_H

typedef struct Node Node;

struct Bucket {
    unsigned int hash;
    Node *first;
};

int node_count(const struct Bucket *bucket);
Node *node_make(int value);

#endif
