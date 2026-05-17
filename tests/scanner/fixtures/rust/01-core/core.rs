// Fixture for the Rust extractor — RS-1 / RS-2 / RS-3 coverage.

use std::collections::HashMap;
use std::rc::Rc;
use std::sync::{Arc, Weak};

pub mod engine {
    use super::*;

    pub struct Node {
        pub value: i32,
        pub next: Option<Box<Node>>,
    }

    pub struct Registry {
        pub root: Box<Node>,
        pub shared_root: Rc<Node>,
        pub arc_root: Arc<Node>,
        pub weak_root: Weak<Node>,
        pub children: Vec<Node>,
        pub by_name: HashMap<String, Node>,
        pub observer: Option<Node>,
        pub borrowed: *const Node,
        pub borrowed_mut: *mut Node,
    }

    pub enum Event {
        Pushed,
        Popped(Node),
        Updated { node: Node, depth: i32 },
    }

    pub trait Visitor {
        fn visit(&self, node: &Node);
    }

    impl Registry {
        pub fn new() -> Self {
            Registry {
                root: Box::new(Node { value: 0, next: None }),
                shared_root: Rc::new(Node { value: 0, next: None }),
                arc_root: Arc::new(Node { value: 0, next: None }),
                weak_root: Weak::new(),
                children: Vec::new(),
                by_name: HashMap::new(),
                observer: None,
                borrowed: std::ptr::null(),
                borrowed_mut: std::ptr::null_mut(),
            }
        }
    }

    impl Visitor for Registry {
        fn visit(&self, _node: &Node) {}
    }

    pub type NodeRef = Box<Node>;
    pub const MAX_DEPTH: i32 = 16;
}

pub fn launch() {}
