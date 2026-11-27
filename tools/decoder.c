/*
 * Выполняет общую языковую модель на CPU. Веса и таблица подслов общие для
 * всех языков; на свежем префиксе JS переиспользует K/V до первой разницы.
 */
#ifndef W
#define W 256
#endif
#define H (W/32)
#define D 32
#define F (3*W)
#define L 6
#define T 128
#define V 16384
extern float expf(float);
extern float tanhf(float);
typedef struct {
    float n1[W], b1[W], qkv[3*W][W], out[W][W], n2[W], b2[W];
    float up[F][W], ub[F], down[W][F], db[W];
} Block;
static struct {
    float word[V][W], pos[T][W]; Block block[L]; float norm[W], bias[W];
    float detector[64][W], detector_bias[64], languages[3][64], language_bias[3];
} weights;
static float keys[L][T][W], values[L][T][W], logits[V], x[W], z[W], qkv[3*W], mix[W], tmp[W], hidden[F];
static unsigned snippet[8];
unsigned weight_address(void) { return (unsigned)&weights; }
unsigned weight_count(void) { return sizeof(weights)/sizeof(float); }
unsigned logits_address(void) { return (unsigned)logits; }
unsigned snippet_address(void) {return (unsigned)snippet;}

static float dot(const float *a,const float *b,int n) {
    float sum=0;
    for(int i=0;i<n;i++) sum+=a[i]*b[i];
    return sum;
}
static void linear(const float *matrix,const float *input,float *output,int rows,int columns) {
    for(int i=0;i<rows;i++) output[i]=dot(matrix+i*columns,input,columns);
}
static void norm(const float *input,const float *scale,const float *bias,float *output) {
    float sum=0,variance=0;
    for(int i=0;i<W;i++) sum+=input[i];
    float mean=sum/W;
    for(int i=0;i<W;i++){float d=input[i]-mean;variance+=d*d;}
    float inv=1.0f/__builtin_sqrtf(variance/W+1e-5f);
    for(int i=0;i<W;i++)output[i]=(input[i]-mean)*inv*scale[i]+bias[i];
}
static float gelu(float a){return 0.5f*a*(1+tanhf(0.79788456f*(a+0.044715f*a*a*a)));}

/* Записывает три оценки языка для последних восьми подслов в буфер logits. */
void detect(unsigned count){
    if(count>8)return;
    float total=0,coef=1;
    for(int i=0;i<W;i++)z[i]=0;
    for(int j=(int)count-1;j>=0;j--){
        if(snippet[j]<6 || snippet[j]>=V)continue;
        for(int i=0;i<W;i++)z[i]+=coef*weights.word[snippet[j]][i];
        total+=coef;coef*=0.78f;
    }
    for(int i=0;i<W;i++)z[i]/=(total>0?total:1);
    linear(&weights.detector[0][0],z,hidden,64,W);
    for(int i=0;i<64;i++)hidden[i]=gelu(hidden[i]+weights.detector_bias[i]);
    linear(&weights.languages[0][0],hidden,logits,3,64);
    for(int i=0;i<3;i++)logits[i]+=weights.language_bias[i];
}

/* Обрабатывает одну позицию; классификация нужна только при выборе следующего токена. */
void step(unsigned token,unsigned pos,int classify) {
    if(token>=V || pos>=T)return;
    for(int i=0;i<W;i++)x[i]=weights.word[token][i]+weights.pos[pos][i];
    for(int l=0;l<L;l++){
        Block *b=&weights.block[l];
        norm(x,b->n1,b->b1,z);
        linear(&b->qkv[0][0],z,qkv,3*W,W);
        for(int i=0;i<W;i++){keys[l][pos][i]=qkv[W+i];values[l][pos][i]=qkv[2*W+i];}
        for(int h=0;h<H;h++){
            float scores[T],maximum=-1e30f,total=0;
            const int k=h*D;
            for(unsigned j=0;j<=pos;j++){
                scores[j]=dot(qkv+k,keys[l][j]+k,D)*0.1767766953f;
                if(scores[j]>maximum)maximum=scores[j];
            }
            for(unsigned j=0;j<=pos;j++){scores[j]=expf(scores[j]-maximum);total+=scores[j];}
            for(int i=0;i<D;i++)mix[k+i]=0;
            for(unsigned j=0;j<=pos;j++){
                float a=scores[j]/total;
                for(int i=0;i<D;i++)mix[k+i]+=a*values[l][j][k+i];
            }
        }
        linear(&b->out[0][0],mix,tmp,W,W);
        for(int i=0;i<W;i++)x[i]+=tmp[i];
        norm(x,b->n2,b->b2,z);
        linear(&b->up[0][0],z,hidden,F,W);
        for(int i=0;i<F;i++)hidden[i]=gelu(hidden[i]+b->ub[i]);
        linear(&b->down[0][0],hidden,tmp,W,F);
        for(int i=0;i<W;i++)x[i]+=tmp[i]+b->db[i];
    }
    if(classify){norm(x,weights.norm,weights.bias,z);linear(&weights.word[0][0],z,logits,V,W);}
}
