/* DreamGraph wave-1 C-4 fixture: singly-linked list. */
typedef struct Node Node;

struct Node {
    int value;
    Node *next;
};

struct ListHead {
    Node *first;
};
