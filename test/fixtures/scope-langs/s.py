def helper():
    return 1

def outer():
    def helper():
        return 2
    return helper()

def other():
    return helper()
