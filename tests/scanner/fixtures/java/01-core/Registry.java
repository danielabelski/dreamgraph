package com.example.engine;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.HashMap;
import com.example.support.Logger;
import com.example.util.*;

@Component
public class Registry extends BaseRegistry implements Visitor, Lifecycle {

  @Inject
  private Logger logger;

  private final List<Node> children;
  private final Map<String, Node> byName;
  private Optional<Node> observer;
  private Node[] backing;
  public static final int MAX_DEPTH = 16;

  public Registry() {
    this.children = new java.util.ArrayList<>();
    this.byName = new HashMap<>();
    this.observer = Optional.empty();
    this.backing = new Node[0];
  }

  @Override
  public void visit(Node n) {
    this.children.add(n);
  }

  public Node lookup(String name) {
    return byName.get(name);
  }
}

interface Visitor {
  void visit(Node n);
}

interface Lifecycle extends AutoCloseable {
  void start();
}

abstract class BaseRegistry {
  protected int generation;
}

enum Phase {
  INIT, RUNNING, STOPPED
}

record Node(String name, int depth) {}

@interface Component {}
