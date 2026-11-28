/* Bind the dl* calls in C to GLIBC_2.2.5 as well (see glibc217.S). */
__asm__(".symver dlopen, dlopen@GLIBC_2.2.5");
__asm__(".symver dlsym, dlsym@GLIBC_2.2.5");
__asm__(".symver dlerror, dlerror@GLIBC_2.2.5");
__asm__(".symver dlclose, dlclose@GLIBC_2.2.5");
