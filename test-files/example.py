class Calculator:
    def __init__(self):
        self.result = 0
    
    def add(self, a, b):
        self.result = a + b
        return self.result
    
    def subtract(self, a, b):
        self.result = a - b
        return self.result

def greet(name):
    return f"Hello, {name}!"

class Point:
    def __init__(self, x, y):
        self.x = x
        self.y = y
