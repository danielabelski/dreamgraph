/* DreamGraph wave-1 C-5 fixture: intrusive list (Linux-kernel style). */

/* list_head is itself a doubly-linked list anchor (next + prev). */
struct list_head {
    struct list_head *next;
    struct list_head *prev;
};

/* Task embeds the list anchor by value -> IntrusiveListShape. */
struct Task {
    int pid;
    struct list_head tasks;
};
