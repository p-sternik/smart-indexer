package com.example;

public class HelloWorld {
    private String message;
    
    public HelloWorld(String msg) {
        this.message = msg;
    }
    
    public void printMessage() {
        System.out.println(message);
    }
    
    public static void main(String[] args) {
        HelloWorld hello = new HelloWorld("Hello from Java!");
        hello.printMessage();
    }
}

interface Greeting {
    void greet();
}

enum Color {
    RED, GREEN, BLUE
}
