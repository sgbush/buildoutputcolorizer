







#include <cstddef>
#include <cstdlib>



bool FunctionA(int param)
{
    return true;
}

extern void FunctionB();


int main(int , char** )
{

    Functiona(0);

    FunctionA(1, 2, 3);

    FunctionB();

    std::exit(0);
}










